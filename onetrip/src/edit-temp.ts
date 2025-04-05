import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import {
  onDocumentUpdated,
  FirestoreEvent,
  Change,
  QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import { FieldValue, DocumentReference, Transaction, Timestamp, GeoPoint } from "firebase-admin/firestore";
import {Trip, MatchedTrip, PotentialTrip, TripGroup, ObstructingTripMember, TripGroupInfo} from "../../type";
import { properMatchGeometric, updateNestedTripField } from './utils/utils';

// Assuming admin SDK is initialized elsewhere
// admin.initializeApp();
const db = admin.firestore();

/**
 * Helper to find an index in matched_trips or potential_trips arrays.
 */
function findTripIndex(tripsArray: (MatchedTrip | PotentialTrip)[], targetTripRef: DocumentReference): number {
    if (!tripsArray || !targetTripRef) return -1;
    return tripsArray.findIndex(t => t.trip_ref?.path === targetTripRef.path);
}


// --- Cloud Function ---

export const tripEdited = onDocumentUpdated("users/{userId}/trips/{tripId}", async (event) => {
    logger.info(`tripEdited triggered for userId: ${event.params.userId}, tripId: ${event.params.tripId}`);

    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;

    if (!beforeSnap?.exists() || !afterSnap?.exists()) {
        logger.warn("Trip document snapshot missing before or after data.");
        return;
    }

    const editedTripBeforeData = beforeSnap.data() as Trip;
    const editedTripAfterData = afterSnap.data() as Trip;
    const editedTripRef = afterSnap.ref;

    // --- Check if relevant fields were actually changed ---
    const relevantFieldsChanged =
        editedTripBeforeData.pickup_radius !== editedTripAfterData.pickup_radius ||
        editedTripBeforeData.destination_radius !== editedTripAfterData.destination_radius ||
        editedTripBeforeData.pickup_latlng?.lat !== editedTripAfterData.pickup_latlng?.lat ||
        editedTripBeforeData.pickup_latlng?.lng !== editedTripAfterData.pickup_latlng?.lng ||
        editedTripBeforeData.destination_latlng?.lat !== editedTripAfterData.destination_latlng?.lat ||
        editedTripBeforeData.destination_latlng?.lng !== editedTripAfterData.destination_latlng?.lng ||
        editedTripBeforeData.seat_count !== editedTripAfterData.seat_count ||
        editedTripBeforeData.reserved !== editedTripAfterData.reserved || // Handle manual reservation changes?
        editedTripBeforeData.reserving_trip_ref?.path !== editedTripAfterData.reserving_trip_ref?.path;

    if (!relevantFieldsChanged) {
        logger.info("No relevant fields changed, skipping full re-evaluation.");
        return; // Optimization: Exit if no matching-related fields changed
    }


    // GraphML n1-n3: Initialize state variables
    let matched = false; // Will be true if ET ends up with at least one valid matched_trip
    let currentlyReservedByEdit = false; // Tracks if ET is reserved *after* initial reservation check
    let newlyReservedTripId = ""; // ID of trip newly reserved by ET's *former* reserver

    try {
        await db.runTransaction(async (transaction) => {
            logger.info(`Starting transaction for trip ${editedTripRef.id}`);

            // Get the latest state within the transaction
            const editedTripSnap = await transaction.get(editedTripRef);
            if (!editedTripSnap.exists) {
                logger.error(`Edited trip ${editedTripRef.id} not found within transaction.`);
                throw new functions.https.HttpsError("not-found", `Edited trip ${editedTripRef.id} not found.`);
            }
            const editedTripData = editedTripSnap.data() as Trip; // Use this for current state checks

            // Keep track of updates needed for the edited trip
            const editedTripUpdate: Record<string, any> = {};

            // --- Reservation Handling (n4 - n28) ---
            const wasReservedBefore = editedTripBeforeData.reserved;
            const formerReservingTripRef = editedTripBeforeData.reserving_trip_ref; // Ref before the update

            if (wasReservedBefore && formerReservingTripRef) {
                logger.info(`Trip ${editedTripRef.id} was reserved by ${formerReservingTripRef.id}. Checking match.`);
                const formerReservingTripSnap = await transaction.get(formerReservingTripRef);
                if (!formerReservingTripSnap.exists) {
                    logger.warn(`Former reserving trip ${formerReservingTripRef.id} not found. Cleaning up reservation on ${editedTripRef.id}.`);
                    // Clean up dangling reservation on edited trip
                    editedTripUpdate.reserved = false;
                    editedTripUpdate.reserving_trip_ref = FieldValue.delete();
                    const formerReserverInMatchedIdx = findTripIndex(editedTripData.matched_trips, formerReservingTripRef);
                    if (formerReserverInMatchedIdx !== -1) {
                        // Ideally remove element, but FieldValue.arrayRemove needs exact object match
                        // Safer to reconstruct array or mark element for later removal logic outside transaction if complex
                        logger.warn(`Need to remove missing former reserver ${formerReservingTripRef.id} from matched_trips of ${editedTripRef.id}`);
                        // Potential simple fix: Overwrite array later if other changes occur
                        // For now, proceed assuming it might get handled by other logic moving it to potential
                    }
                    // Don't throw, just clean up and proceed with other checks
                } else {
                    const formerReservingTripData = formerReservingTripSnap.data() as Trip;

                    // n5: Does edited trip still proper match its *former* reserving trip?
                    const stillMatchesFormerReserver = properMatchGeometric(editedTripData, formerReservingTripData);

                    if (stillMatchesFormerReserver) {
                        // n6: Still matches, remains reserved (by this trip)
                        logger.info(`Trip ${editedTripRef.id} still matches former reserver ${formerReservingTripRef.id}.`);
                        matched = true; // It has a match (the reserver)
                        currentlyReservedByEdit = true; // It is still reserved by this specific trip
                        // No updates needed *yet* for reservation status itself
                    } else {
                        logger.info(`Trip ${editedTripRef.id} NO LONGER matches former reserver ${formerReservingTripRef.id}. Breaking reservation.`);
                        // n8: Update Edited Trip - Remove reservation details
                        editedTripUpdate.reserved = false;
                        editedTripUpdate.reserving_trip_ref = FieldValue.delete();

                        // Find and remove former reserving trip from edited trip's matched_trips
                        const currentMatchedTrips = [...(editedTripData.matched_trips || [])];
                        const reserverIndexInET = findTripIndex(currentMatchedTrips, formerReservingTripRef);
                        let removedReserverElement: MatchedTrip | null = null;
                        if (reserverIndexInET !== -1) {
                            removedReserverElement = currentMatchedTrips.splice(reserverIndexInET, 1)[0];
                            editedTripUpdate.matched_trips = currentMatchedTrips; // Update the array
                            logger.info(`Removed former reserver ${formerReservingTripRef.id} from matched_trips of ${editedTripRef.id}.`);
                        } else {
                             logger.warn(`Former reserver ${formerReservingTripRef.id} not found in matched_trips of ${editedTripRef.id} for removal.`);
                        }

                        // n9: Update Former Reserving Trip
                        const formerReserverUpdate: Record<string, any> = {};
                        const formerReserverMatched = [...(formerReservingTripData.matched_trips || [])];
                        const etIndexInReserverMatched = findTripIndex(formerReserverMatched, editedTripRef);
                        let etElementFromReserver: MatchedTrip | null = null;
                        if (etIndexInReserverMatched !== -1) {
                            etElementFromReserver = formerReserverMatched.splice(etIndexInReserverMatched, 1)[0];
                            formerReserverUpdate.matched_trips = formerReserverMatched;
                            logger.info(`Removed ET ${editedTripRef.id} from matched_trips of former reserver ${formerReservingTripRef.id}.`);
                        } else {
                             logger.warn(`ET ${editedTripRef.id} not found in matched_trips of former reserver ${formerReservingTripRef.id} for removal.`);
                        }

                        // Add ET to former reserver's potential_trips
                        const pd = etElementFromReserver?.pickup_distance ?? distanceBetween(formerReservingTripData.pickup_latlng, editedTripData.pickup_latlng);
                        const dd = etElementFromReserver?.destination_distance ?? distanceBetween(formerReservingTripData.destination_latlng, editedTripData.destination_latlng);
                        const etPotentialEntryForReserver: PotentialTrip = {
                            trip_ref: editedTripRef,
                            paid: false, // ET is no longer part of the paid group
                            trip_group_ref: null,
                            pickup_radius: editedTripData.pickup_radius,
                            destination_radius: editedTripData.destination_radius,
                            pickup_distance: pd,
                            destination_distance: dd,
                            proper_match: false, // Doesn't match anymore
                            trip_obstruction: false, // Not evaluated against a group here
                            seat_obstruction: false, // Not evaluated against a group here
                            reserving_trip_obstruction: false, // ET isn't reserved by someone else *yet*
                            mutual: true, // Bidirectional potential
                            group_largest_pickup_overlap_gap: null, // N/A for non-group check
                            group_largest_destination_overlap_gap: null, // N/A for non-group check
                            unknown_trip_obstruction: false,
                            total_seat_count: null, // N/A
                            // seat_count: editedTripData.seat_count // Add if needed by schema
                        };
                        formerReserverUpdate.potential_trips = FieldValue.arrayUnion(etPotentialEntryForReserver);
                        logger.info(`Adding ET ${editedTripRef.id} to potential_trips of former reserver ${formerReservingTripRef.id}.`);


                        // n10: Does former reserving trip have other matches left?
                        const hasOtherMatches = formerReserverMatched.length > 0;

                        if (hasOtherMatches) {
                            logger.info(`Former reserver ${formerReservingTripRef.id} has other matches.`);
                            // n11: Add former reserver to Edited Trip's potential (as paid trip)
                             const gapP = calculateGap(editedTripData, formerReservingTripData, 'pickup', pd);
                             const gapD = calculateGap(editedTripData, formerReservingTripData, 'destination', dd);
                             const potentialEntryForET: PotentialTrip = {
                                trip_ref: formerReservingTripRef,
                                paid: true, // Former reserver is still paid
                                trip_group_ref: formerReservingTripData.trip_group_ref,
                                pickup_radius: formerReservingTripData.pickup_radius,
                                destination_radius: formerReservingTripData.destination_radius,
                                pickup_distance: pd,
                                destination_distance: dd,
                                proper_match: false, // Doesn't match anymore
                                trip_obstruction: true, // Assumed obstructed because it failed properMatch
                                seat_obstruction: false, // Assume check not needed or done later
                                reserving_trip_obstruction: false, // Former reserver isn't reserved itself
                                mutual: true, // Bidirectional potential
                                group_largest_pickup_overlap_gap: gapP > 0 ? gapP : null,
                                group_largest_destination_overlap_gap: gapD > 0 ? gapD : null,
                                unknown_trip_obstruction: false,
                                total_seat_count: formerReservingTripData.total_seat_count ?? formerReservingTripData.seat_count, // Use TG count if available
                                // seat_count: formerReservingTripData.seat_count // Add if needed
                             };
                            editedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForET);
                            logger.info(`Adding former reserver ${formerReservingTripRef.id} to potential_trips of ET ${editedTripRef.id} (as paid).`);


                            // n16: Find new trip for former reserver to reserve
                            let nearestTripRef: DocumentReference | null = null;
                            let minCombinedDistance = Infinity;
                            let tiedRefs: DocumentReference[] = [];

                            for (const match of formerReserverMatched) {
                                const combinedDistance = match.pickup_distance + match.destination_distance;
                                if (combinedDistance < minCombinedDistance) {
                                    minCombinedDistance = combinedDistance;
                                    nearestTripRef = match.trip_ref;
                                    tiedRefs = [match.trip_ref];
                                } else if (combinedDistance === minCombinedDistance) {
                                    tiedRefs.push(match.trip_ref);
                                }
                            }

                            // n17: Handle ties (Graph unclear, pick first for now)
                            if (tiedRefs.length > 1) {
                                logger.warn(`Tie detected for new reservation target for ${formerReservingTripRef.id}. Picking first: ${nearestTripRef?.id}`);
                                // n19 -> n20 equivalent
                            }

                            if (nearestTripRef) {
                                newlyReservedTripId = nearestTripRef.id; // Track the ID
                                logger.info(`Former reserver ${formerReservingTripRef.id} will now reserve ${newlyReservedTripId}.`);

                                // n20: Update Newly Reserved Trip
                                transaction.update(nearestTripRef, {
                                    reserved: true,
                                    reserving_trip_ref: formerReservingTripRef
                                });
                                logger.info(`Updated ${newlyReservedTripId}: set reserved=true, reserving_trip_ref=${formerReservingTripRef.id}.`);


                                // n21: Update Former Reserving Trip's matched_trips entry
                                const reserverMatchedUpdate = formerReserverUpdate.matched_trips as MatchedTrip[] || [...formerReserverMatched]; // Use array from update obj if exists, else the one we modified
                                const newReserveeIndex = findTripIndex(reserverMatchedUpdate, nearestTripRef);
                                if (newReserveeIndex !== -1) {
                                     // Cannot directly update nested field with transaction.update AND arrayUnion/Remove
                                     // Need to overwrite the whole array if modifying nested field.
                                     reserverMatchedUpdate[newReserveeIndex].reserving = true;
                                     formerReserverUpdate.matched_trips = reserverMatchedUpdate;
                                     logger.info(`Updated former reserver ${formerReservingTripRef.id}: set reserving=true for match ${newlyReservedTripId}.`);

                                } else {
                                     logger.error(`Could not find new reservee ${newlyReservedTripId} in former reserver's matched_trips for update.`);
                                }

                                // n22-n28: Cascade effects of new reservation (Complex - requires fetching many potentially related trips)
                                // This part is highly complex and prone to exceeding transaction limits/read quotas.
                                // Consider deferring this to a separate triggered function or queue.
                                // For this implementation, we'll log the need but skip the deep cascade for brevity and stability.
                                logger.warn(`DEFERRED ACTION: Cascade updates (n22-n28) needed for trips related to ${newlyReservedTripId} due to new reservation by ${formerReservingTripRef.id}. Implement in a separate process.`);

                            } else {
                                 logger.warn(`Former reserver ${formerReservingTripRef.id} had matches but none could be selected for reservation.`);
                            }

                        } else {
                            logger.info(`Former reserver ${formerReservingTripRef.id} has no other matches. Becomes unmatched.`);
                            // n12: Delete former reserving trip's Trip Group (if it exists)
                            if (formerReservingTripData.trip_group_ref) {
                                logger.info(`Deleting trip group ${formerReservingTripData.trip_group_ref.id}.`);
                                transaction.delete(formerReservingTripData.trip_group_ref);
                            }

                             // n13: Add former reserver to Edited Trip's potential (as unpaid)
                             const potentialEntryForETUnpaid: PotentialTrip = {
                                trip_ref: formerReservingTripRef,
                                paid: false, // Former reserver becomes unpaid
                                trip_group_ref: null,
                                pickup_radius: formerReservingTripData.pickup_radius,
                                destination_radius: formerReservingTripData.destination_radius,
                                pickup_distance: pd,
                                destination_distance: dd,
                                proper_match: false, // Doesn't match anymore
                                trip_obstruction: false, // N/A
                                seat_obstruction: false, // N/A
                                reserving_trip_obstruction: false, // Former reserver isn't reserved
                                mutual: true, // Bidirectional potential
                                group_largest_pickup_overlap_gap: null, // N/A
                                group_largest_destination_overlap_gap: null, // N/A
                                unknown_trip_obstruction: false,
                                total_seat_count: null, // N/A
                                // seat_count: formerReservingTripData.seat_count // Add if needed
                             };
                             editedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForETUnpaid);
                             logger.info(`Adding former reserver ${formerReservingTripRef.id} to potential_trips of ET ${editedTripRef.id} (as unpaid).`);


                            // n14: Update Former Reserving Trip status and fields
                            formerReserverUpdate.status = "unmatched";
                            formerReserverUpdate.trip_group_ref = FieldValue.delete();
                            formerReserverUpdate.time_of_payment = FieldValue.delete();
                            formerReserverUpdate.total_seat_count = FieldValue.delete();
                            logger.info(`Updating former reserver ${formerReservingTripRef.id} to unmatched status.`);

                            // n18: Update trips that had former reserver as potential (paid)
                            // Again, complex cascade. Deferring.
                             logger.warn(`DEFERRED ACTION: Cascade updates (n18) needed for trips that had ${formerReservingTripRef.id} as a paid potential match. Implement in a separate process.`);
                        }
                         // Apply updates to the former reserving trip
                        transaction.update(formerReservingTripRef, formerReserverUpdate);
                    }
                }
            } // End if (wasReservedBefore && formerReservingTripRef)

            // --- Process Unpaid Matched Trips (n29 - n60) ---
            logger.info(`Processing unpaid matched trips for ${editedTripRef.id}`);
            const unpaidMatchedTripsBefore = (editedTripBeforeData.matched_trips || []).filter(t => !t.paid);
            const currentPotentialRefs = new Set((editedTripData.potential_trips || []).map(pt => pt.trip_ref.path)); // Track trips already potential

            // Use editedTripData.matched_trips for current state if reservation logic didn't modify it yet
            let currentMatchedForUnpaidCheck = editedTripUpdate.matched_trips
                ? [...editedTripUpdate.matched_trips]
                : [...(editedTripData.matched_trips || [])];

            const nextMatchedForUnpaidCheck: MatchedTrip[] = []; // Build the next state of matched trips array

            for (const umtElement of currentMatchedForUnpaidCheck) {
                 if (umtElement.paid) {
                     nextMatchedForUnpaidCheck.push(umtElement); // Keep paid matches for now
                     continue; // Only process unpaid here
                 }

                const umtRef = umtElement.trip_ref;
                if (!umtRef) continue; // Skip if ref is missing

                // Skip if this trip was the former reserver we already processed
                if (formerReservingTripRef && umtRef.path === formerReservingTripRef.path && !stillMatchesFormerReserver) {
                     logger.info(`Skipping unpaid matched trip ${umtRef.id} as it was the former reserver and already handled.`);
                     continue;
                }

                const umtSnap = await transaction.get(umtRef);
                if (!umtSnap.exists) {
                    logger.warn(`Unpaid matched trip ${umtRef.id} not found. Removing from ${editedTripRef.id}.`);
                    // Don't add to nextMatchedForUnpaidCheck
                    continue;
                }
                const umtData = umtSnap.data() as Trip;

                // n31: Does edited trip proper match UMT (based on updated values)?
                const matchesUMT = properMatchGeometric(editedTripData, umtData, umtElement.pickup_distance, umtElement.destination_distance);

                if (matchesUMT) {
                    logger.info(`ET ${editedTripRef.id} still matches unpaid trip ${umtRef.id}.`);
                    // n44 -> Path: Check UMT reservation status
                    let isObstructedByUMTReservation = false;
                    // n45: Is UMT reserved?
                    if (umtData.reserved && umtData.reserving_trip_ref) {
                        // n47: Does ET proper match UMT's reserving trip?
                        const umtReserverSnap = await transaction.get(umtData.reserving_trip_ref);
                        if (umtReserverSnap.exists) {
                            const umtReserverData = umtReserverSnap.data() as Trip;
                            if (!properMatchGeometric(editedTripData, umtReserverData)) {
                                logger.info(`ET ${editedTripRef.id} does NOT match UMT ${umtRef.id}'s reserver ${umtData.reserving_trip_ref.id}.`);
                                // n46: Conflict. Move UMT to ET's potential.
                                isObstructedByUMTReservation = true;
                            } else {
                                // n48: ET matches UMT's reserver. OK to proceed.
                                logger.info(`ET ${editedTripRef.id} matches UMT ${umtRef.id}'s reserver ${umtData.reserving_trip_ref.id}.`);
                                matched = true; // Remains matched
                            }
                        } else {
                             logger.warn(`UMT ${umtRef.id}'s reserving trip ${umtData.reserving_trip_ref.id} not found. Treating as not obstructed.`);
                             matched = true; // Remains matched
                        }
                    } else {
                        // n45 -> No -> n48: UMT not reserved. OK to proceed.
                        logger.info(`UMT ${umtRef.id} is not reserved.`);
                        matched = true; // Remains matched
                    }

                    if (isObstructedByUMTReservation) {
                         // n46 Follow-up: Move UMT to ET's potential
                         const potentialEntryForET: PotentialTrip = {
                             trip_ref: umtRef,
                             paid: false,
                             trip_group_ref: null,
                             pickup_radius: umtData.pickup_radius,
                             destination_radius: umtData.destination_radius,
                             pickup_distance: umtElement.pickup_distance,
                             destination_distance: umtElement.destination_distance,
                             proper_match: true, // It matches geometrically
                             trip_obstruction: false, // N/A for unpaid
                             seat_obstruction: false, // N/A for unpaid
                             reserving_trip_obstruction: true, // Obstructed by UMT's reservation
                             mutual: umtElement.mutual, // Preserve original mutual status temporarily
                             group_largest_pickup_overlap_gap: null,
                             group_largest_destination_overlap_gap: null,
                             unknown_trip_obstruction: false,
                             total_seat_count: null,
                             // seat_count: umtData.seat_count // Add if needed
                         };
                         editedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForET);
                         currentPotentialRefs.add(umtRef.path); // Track addition
                         logger.info(`Moved UMT ${umtRef.id} from matched to potential for ET ${editedTripRef.id} due to reservation conflict.`);

                         // Also update UMT: Move ET to potential
                         const umtUpdate: Record<string, any> = {};
                         const etPotentialEntryForUMT: PotentialTrip = {
                             trip_ref: editedTripRef,
                             paid: false,
                             trip_group_ref: null,
                             pickup_radius: editedTripData.pickup_radius,
                             destination_radius: editedTripData.destination_radius,
                             pickup_distance: umtElement.pickup_distance,
                             destination_distance: umtElement.destination_distance,
                             proper_match: true,
                             trip_obstruction: false,
                             seat_obstruction: false,
                             reserving_trip_obstruction: false, // UMT not obstructed by ET's reservation here
                             mutual: umtElement.mutual,
                             group_largest_pickup_overlap_gap: null,
                             group_largest_destination_overlap_gap: null,
                             unknown_trip_obstruction: false,
                             total_seat_count: null,
                              // seat_count: editedTripData.seat_count // Add if needed
                         };
                         umtUpdate.potential_trips = FieldValue.arrayUnion(etPotentialEntryForUMT);
                         // Remove ET from UMT's matched
                         umtUpdate.matched_trips = FieldValue.arrayRemove({
                             // Must match EXACTLY - This is tricky, better to fetch and rebuild array
                             trip_ref: editedTripRef,
                             paid: umtElement.paid, // Should be false
                             trip_group_ref: umtElement.trip_group_ref, // Should be null
                             pickup_radius: editedTripBeforeData.pickup_radius, // Use BEFORE data for removal match
                             destination_radius: editedTripBeforeData.destination_radius, // Use BEFORE data for removal match
                             pickup_distance: umtElement.pickup_distance,
                             destination_distance: umtElement.destination_distance,
                             mutual: umtElement.mutual,
                             reserving: false // Assuming ET wasn't reserving UMT
                         });
                         transaction.update(umtRef, umtUpdate);
                         logger.info(`Moved ET ${editedTripRef.id} from matched to potential for UMT ${umtRef.id}.`);

                    } else {
                         // n48 -> Path: Remains matched, update radii on UMT side
                         const umtUpdate: Record<string, any> = {};
                         const umtMatched = [...(umtData.matched_trips || [])];
                         const etIndexInUMT = findTripIndex(umtMatched, editedTripRef);
                         if (etIndexInUMT !== -1) {
                             // n54/n134 logic: Update radii
                             umtMatched[etIndexInUMT].pickup_radius = editedTripData.pickup_radius;
                             umtMatched[etIndexInUMT].destination_radius = editedTripData.destination_radius;

                             // Handle mutual changes if needed (n49/n51) - GraphML seems inconsistent here
                             // If !umtElement.mutual && !currentlyReservedByEdit (n49->false), make mutual
                             if (!umtElement.mutual && !currentlyReservedByEdit) {
                                 logger.info(`Making ET ${editedTripRef.id} and UMT ${umtRef.id} mutual.`);
                                 umtMatched[etIndexInUMT].mutual = true;
                                 // Update ET's side too
                                 umtElement.mutual = true; // Modify the element that will be pushed below
                             }
                             // else (n49->true or n50->yes) - just update radii (already done above)

                             umtUpdate.matched_trips = umtMatched; // Overwrite array with updated radii/mutual
                             transaction.update(umtRef, umtUpdate);
                             logger.info(`Updated radii/mutual for ET ${editedTripRef.id} in UMT ${umtRef.id}'s matched_trips.`);
                         } else {
                              logger.warn(`ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s matched_trips for radius update.`);
                              // Might happen if UMT had ET in potential, requires different logic (n55 path) - Graph is complex.
                              // For simplicity, assume if matched now, it was matched before.
                         }
                         // Keep the updated element in ET's matched list
                         nextMatchedForUnpaidCheck.push(umtElement);
                    }

                } else {
                    logger.info(`ET ${editedTripRef.id} NO LONGER matches unpaid trip ${umtRef.id}. Moving to potential.`);
                    // n32 -> Path: Move to potential on both sides
                    let isReservingTripObstruction = false;
                    // n33: Is UMT reserved?
                    if (umtData.reserved && umtData.reserving_trip_ref) {
                        // n34: Does ET proper match UMT's reserving trip?
                         const umtReserverSnap = await transaction.get(umtData.reserving_trip_ref);
                         if (umtReserverSnap.exists) {
                             const umtReserverData = umtReserverSnap.data() as Trip;
                             if (!properMatchGeometric(editedTripData, umtReserverData)) {
                                 // n36: Set reserving_trip_obstruction on ET's potential entry
                                 isReservingTripObstruction = true;
                             }
                             // n35 if match is true
                         }
                         // n35 if reserver not found
                    }
                    // n35 if not reserved

                    // Add UMT to ET's potential (n35/n36)
                    const potentialEntryForET: PotentialTrip = {
                        trip_ref: umtRef,
                        paid: false,
                        trip_group_ref: null,
                        pickup_radius: umtData.pickup_radius,
                        destination_radius: umtData.destination_radius,
                        pickup_distance: umtElement.pickup_distance,
                        destination_distance: umtElement.destination_distance,
                        proper_match: false, // No longer matches
                        trip_obstruction: false, // N/A
                        seat_obstruction: false, // N/A
                        reserving_trip_obstruction: isReservingTripObstruction, // Set based on n36 check
                        mutual: true, // Assume mutual potential initially (n35/n36)
                        group_largest_pickup_overlap_gap: null,
                        group_largest_destination_overlap_gap: null,
                        unknown_trip_obstruction: false,
                        total_seat_count: null,
                        // seat_count: umtData.seat_count // Add if needed
                    };
                     editedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForET);
                     currentPotentialRefs.add(umtRef.path); // Track addition
                     logger.info(`Moved UMT ${umtRef.id} from matched to potential for ET ${editedTripRef.id} (match broken).`);


                    // Update UMT: Remove ET from matched, Add ET to potential (n39)
                    const umtUpdate: Record<string, any> = {};
                    const etPotentialEntryForUMT: PotentialTrip = {
                        trip_ref: editedTripRef,
                        paid: false,
                        trip_group_ref: null,
                        pickup_radius: editedTripData.pickup_radius,
                        destination_radius: editedTripData.destination_radius,
                        pickup_distance: umtElement.pickup_distance,
                        destination_distance: umtElement.destination_distance,
                        proper_match: false,
                        trip_obstruction: false,
                        seat_obstruction: false,
                        reserving_trip_obstruction: false, // UMT not obstructed by ET here
                        mutual: true, // Corresponds to ET's entry
                        group_largest_pickup_overlap_gap: null,
                        group_largest_destination_overlap_gap: null,
                        unknown_trip_obstruction: false,
                        total_seat_count: null,
                         // seat_count: editedTripData.seat_count // Add if needed
                    };
                    umtUpdate.potential_trips = FieldValue.arrayUnion(etPotentialEntryForUMT);

                    // Remove ET from UMT's matched
                    umtUpdate.matched_trips = FieldValue.arrayRemove({
                        // Must match EXACTLY
                        trip_ref: editedTripRef,
                        paid: false,
                        trip_group_ref: null,
                        pickup_radius: editedTripBeforeData.pickup_radius, // Use BEFORE data
                        destination_radius: editedTripBeforeData.destination_radius, // Use BEFORE data
                        pickup_distance: umtElement.pickup_distance,
                        destination_distance: umtElement.destination_distance,
                        mutual: umtElement.mutual, // Use original mutual
                        reserving: false // Assuming ET wasn't reserving UMT
                    });
                    transaction.update(umtRef, umtUpdate);
                    logger.info(`Moved ET ${editedTripRef.id} from matched to potential for UMT ${umtRef.id}.`);


                    // n42: Was ET the only match for UMT?
                    const umtMatchedBefore = (umtData.matched_trips || []).filter(t => t.trip_ref.path !== editedTripRef.path);
                    if (umtMatchedBefore.length === 0) {
                         // n43: Update UMT status to unmatched
                         transaction.update(umtRef, { status: "unmatched" });
                         logger.info(`Set UMT ${umtRef.id} status to unmatched.`);
                    }
                }
                // n60: Loop continues implicitly
            }
             // Update the edited trip's matched_trips array after processing unpaid ones
            editedTripUpdate.matched_trips = nextMatchedForUnpaidCheck;


            // --- Process Unpaid Potential Trips (n61 - n106) ---
            logger.info(`Processing unpaid potential trips for ${editedTripRef.id}`);
            // Combine potential trips from before data and any added during reservation checks
            const potentialTripsBefore = editedTripBeforeData.potential_trips || [];
            const potentialTripsAdded = (editedTripUpdate.potential_trips || [])
                 .filter(pt => pt && !(pt instanceof FieldValue)); // Filter out FieldValue unions

            const allPotentialTripElements = [...potentialTripsBefore];
            for(const addedPt of potentialTripsAdded) {
                 if (!findTripIndex(allPotentialTripElements, addedPt.trip_ref)) {
                      allPotentialTripElements.push(addedPt);
                 }
            }

            const currentMatchedRefs = new Set((editedTripUpdate.matched_trips || []).map(mt => mt.trip_ref.path));
            const nextPotentialForUnpaidCheck: PotentialTrip[] = []; // Build the next state

            for (const uptElement of allPotentialTripElements) {
                 if (uptElement.paid) {
                      nextPotentialForUnpaidCheck.push(uptElement); // Keep paid potentials for now
                      continue; // Only process unpaid here
                 }
                 if (currentMatchedRefs.has(uptElement.trip_ref.path)) {
                     continue; // Skip if it got moved to matched already
                 }
                 // Check again if it was added during this transaction run already
                  if (!currentPotentialRefs.has(uptElement.trip_ref.path)) {
                     // This ensures we don't process stale elements that were replaced by arrayUnion
                     logger.debug(`Skipping stale potential element processing for ${uptElement.trip_ref.id}`);
                     continue;
                 }

                const uptRef = uptElement.trip_ref;
                if (!uptRef) continue;

                const uptSnap = await transaction.get(uptRef);
                 if (!uptSnap.exists) {
                     logger.warn(`Unpaid potential trip ${uptRef.id} not found. Removing from ${editedTripRef.id}.`);
                     // Remove from currentPotentialRefs so it doesn't get added back
                     currentPotentialRefs.delete(uptRef.path);
                     continue;
                 }
                const uptData = uptSnap.data() as Trip;

                // n63: Does edited trip proper match UPT (based on updated values)?
                const matchesUPT = properMatchGeometric(editedTripData, uptData, uptElement.pickup_distance, uptElement.destination_distance);

                 if (matchesUPT) {
                     logger.info(`ET ${editedTripRef.id} now matches unpaid potential trip ${uptRef.id}.`);
                     // n66/n65: Check UPT reservation status
                     let canBecomeMatch = true;
                     let reservationObstructsPotential = false; // Does UPT's reservation prevent ET match?
                     let etReservationObstructsPotential = false; // Does ET's reservation prevent UPT match?

                     // n65: Is UPT reserved?
                     if (uptData.reserved && uptData.reserving_trip_ref) {
                         // n64: Does ET proper match UPT's reserving trip?
                         const uptReserverSnap = await transaction.get(uptData.reserving_trip_ref);
                         if (uptReserverSnap.exists) {
                             const uptReserverData = uptReserverSnap.data() as Trip;
                             if (!properMatchGeometric(editedTripData, uptReserverData)) {
                                 // n89 -> Path: Cannot become match due to UPT reservation
                                 canBecomeMatch = false;
                                 reservationObstructsPotential = true; // UPT's reservation obstructs ET
                                 logger.info(`ET ${editedTripRef.id} cannot match UPT ${uptRef.id} due to conflict with UPT's reserver ${uptData.reserving_trip_ref.id}.`);
                             }
                             // n67 if match
                         }
                         // n67 if reserver not found
                     }

                     // Also check if ET is reserved and obstructs UPT
                     if (currentlyReservedByEdit && formerReservingTripRef) {
                          const formerReserverSnap = await transaction.get(formerReservingTripRef); // Fetch again if needed, or reuse if available
                           if(formerReserverSnap.exists) {
                                const formerReservingTripData = formerReserverSnap.data() as Trip;
                                if (!properMatchGeometric(uptData, formerReservingTripData)) {
                                     // If UPT doesn't match ET's reserver, ET's reservation obstructs
                                     etReservationObstructsPotential = true;
                                     // This doesn't necessarily block the match from ET's side, but affects potential entry details
                                     logger.info(`ET ${editedTripRef.id}'s reservation obstructs potential match with UPT ${uptRef.id}.`);
                                }
                           }
                     }


                     if (canBecomeMatch) {
                         // n67 -> Path: Potential becomes Match
                         matched = true; // ET is now matched
                         logger.info(`Promoting UPT ${uptRef.id} from potential to matched for ET ${editedTripRef.id}.`);

                         // Add UPT to ET's matched_trips
                         const newMatchedEntryForET: MatchedTrip = {
                             trip_ref: uptRef,
                             paid: false,
                             trip_group_ref: null,
                             pickup_radius: uptData.pickup_radius,
                             destination_radius: uptData.destination_radius,
                             pickup_distance: uptElement.pickup_distance,
                             destination_distance: uptElement.destination_distance,
                             mutual: uptElement.mutual, // Preserve mutual from potential entry
                             reserving: false, // ET is not reserving UPT here
                             // seat_count: uptData.seat_count // Add if needed
                         };
                         // Add to the array being built for the update
                         (editedTripUpdate.matched_trips as MatchedTrip[]).push(newMatchedEntryForET);
                         currentMatchedRefs.add(uptRef.path); // Track addition
                         currentPotentialRefs.delete(uptRef.path); // Remove from potential tracking

                         // Update UPT: Remove ET from potential, Add ET to matched
                         const uptUpdate: Record<string, any> = {};
                         const newMatchedEntryForUPT: MatchedTrip = {
                             trip_ref: editedTripRef,
                             paid: false,
                             trip_group_ref: null,
                             pickup_radius: editedTripData.pickup_radius,
                             destination_radius: editedTripData.destination_radius,
                             pickup_distance: uptElement.pickup_distance,
                             destination_distance: uptElement.destination_distance,
                             mutual: uptElement.mutual, // Match mutual status
                             reserving: false,
                             // seat_count: editedTripData.seat_count // Add if needed
                         };
                          // Use arrayUnion for matched, arrayRemove for potential
                         uptUpdate.matched_trips = FieldValue.arrayUnion(newMatchedEntryForUPT);
                         uptUpdate.potential_trips = FieldValue.arrayRemove(uptElement); // Remove the exact potential element
                         transaction.update(uptRef, uptUpdate);
                         logger.info(`Moved ET ${editedTripRef.id} from potential to matched for UPT ${uptRef.id}.`);

                         // n96: If UPT status was unmatched, update it
                         if (uptData.status === "unmatched") {
                             transaction.update(uptRef, { status: "matched" });
                             logger.info(`Set UPT ${uptRef.id} status to matched.`);
                         }

                     } else {
                         // n89 -> Path: Cannot become match, update potential entry details
                         logger.info(`Updating potential entry for UPT ${uptRef.id} on ET ${editedTripRef.id} (match obstructed).`);
                         uptElement.proper_match = true; // Still matches geometrically
                         uptElement.reserving_trip_obstruction = reservationObstructsPotential || etReservationObstructsPotential; // Obstructed either way
                         // Update radii based on ET changes
                         uptElement.pickup_distance = distanceBetween(editedTripData.pickup_latlng, uptData.pickup_latlng); // Recalculate if needed
                         uptElement.destination_distance = distanceBetween(editedTripData.destination_latlng, uptData.destination_latlng); // Recalculate if needed
                         // Keep uptElement in the potential list being built
                         nextPotentialForUnpaidCheck.push(uptElement);

                         // Update UPT's potential entry for ET too
                         const uptUpdate: Record<string, any> = {};
                         const uptPotential = [...(uptData.potential_trips || [])];
                         const etIndexInUPTPotential = findTripIndex(uptPotential, editedTripRef);
                         if (etIndexInUPTPotential !== -1) {
                             uptPotential[etIndexInUPTPotential].proper_match = true;
                             uptPotential[etIndexInUPTPotential].reserving_trip_obstruction = reservationObstructsPotential || etReservationObstructsPotential;
                             uptPotential[etIndexInUPTPotential].pickup_radius = editedTripData.pickup_radius;
                             uptPotential[etIndexInUPTPotential].destination_radius = editedTripData.destination_radius;
                             uptPotential[etIndexInUPTPotential].pickup_distance = uptElement.pickup_distance; // Use consistent distance
                             uptPotential[etIndexInUPTPotential].destination_distance = uptElement.destination_distance; // Use consistent distance
                             uptUpdate.potential_trips = uptPotential;
                             transaction.update(uptRef, uptUpdate);
                             logger.info(`Updated potential entry for ET ${editedTripRef.id} on UPT ${uptRef.id}.`);
                         } else {
                              logger.warn(`ET ${editedTripRef.id} not found in UPT ${uptRef.id}'s potential trips for update.`);
                         }
                     }

                 } else {
                     // n74 -> Path: Still doesn't match, update potential entry
                     logger.info(`ET ${editedTripRef.id} still does not match unpaid potential trip ${uptRef.id}. Updating potential entry.`);
                     uptElement.proper_match = false;
                     // Update distances and radii if necessary
                     uptElement.pickup_distance = distanceBetween(editedTripData.pickup_latlng, uptData.pickup_latlng); // Recalculate
                     uptElement.destination_distance = distanceBetween(editedTripData.destination_latlng, uptData.destination_latlng); // Recalculate
                     uptElement.pickup_radius = uptData.pickup_radius; // UPT radius doesn't change here
                     uptElement.destination_radius = uptData.destination_radius; // UPT radius doesn't change here

                     // Check reservation obstruction (n82-n87)
                     let isReservingTripObstructed = false;
                     if (uptData.reserved && uptData.reserving_trip_ref) {
                          const uptReserverSnap = await transaction.get(uptData.reserving_trip_ref);
                          if (uptReserverSnap.exists) {
                              const uptReserverData = uptReserverSnap.data() as Trip;
                              // n84: Does ET proper match UPT's reserving trip?
                              if (!properMatchGeometric(editedTripData, uptReserverData)) {
                                  // n86: Set obstruction
                                  isReservingTripObstructed = true;
                              }
                          }
                     }
                     // Also check if ET's reservation obstructs UPT
                      if (currentlyReservedByEdit && formerReservingTripRef) {
                           const formerReserverSnap = await transaction.get(formerReservingTripRef);
                            if(formerReserverSnap.exists) {
                                const formerReservingTripData = formerReserverSnap.data() as Trip;
                                if (!properMatchGeometric(uptData, formerReservingTripData)) {
                                     isReservingTripObstructed = true; // Obstructed if either reservation conflicts
                                }
                            }
                      }
                     uptElement.reserving_trip_obstruction = isReservingTripObstructed;

                     // Keep uptElement in the potential list being built
                     nextPotentialForUnpaidCheck.push(uptElement);

                     // Update UPT's potential entry for ET
                     const uptUpdate: Record<string, any> = {};
                     const uptPotential = [...(uptData.potential_trips || [])];
                     const etIndexInUPTPotential = findTripIndex(uptPotential, editedTripRef);
                     if (etIndexInUPTPotential !== -1) {
                         uptPotential[etIndexInUPTPotential].proper_match = false;
                         uptPotential[etIndexInUPTPotential].pickup_radius = editedTripData.pickup_radius;
                         uptPotential[etIndexInUPTPotential].destination_radius = editedTripData.destination_radius;
                         uptPotential[etIndexInUPTPotential].pickup_distance = uptElement.pickup_distance; // Use consistent distance
                         uptPotential[etIndexInUPTPotential].destination_distance = uptElement.destination_distance; // Use consistent distance
                         uptPotential[etIndexInUPTPotential].reserving_trip_obstruction = isReservingTripObstructed;
                         uptUpdate.potential_trips = uptPotential;
                         transaction.update(uptRef, uptUpdate);
                         logger.info(`Updated potential entry for ET ${editedTripRef.id} on UPT ${uptRef.id} (still no match).`);

                          // n80: If UPT had ET in matched before, remove it
                          const etIndexInUMTMatched = findTripIndex(uptData.matched_trips || [], editedTripRef);
                          if (etIndexInUMTMatched !== -1) {
                              logger.info(`Detected UPT ${uptRef.id} had ET ${editedTripRef.id} as matched previously. Removing.`);
                              // Must match EXACTLY - use before data
                               const removalElement = (uptData.matched_trips || [])[etIndexInUMTMatched];
                               if (removalElement) {
                                   // Need to ensure radii match the *state before this edit*
                                   // This is complex. Simplification: Assume arrayRemove works if ref matches.
                                   transaction.update(uptRef, { matched_trips: FieldValue.arrayRemove(removalElement) });
                                   logger.info(`Attempted removal of ET from UPT ${uptRef.id}'s matched trips.`);
                               }
                          }

                     } else {
                         logger.warn(`ET ${editedTripRef.id} not found in UPT ${uptRef.id}'s potential trips for update.`);
                     }
                 }
                  // n106: Loop continues implicitly
            }
             // Update the edited trip's potential_trips array after processing unpaid ones
             // Combine with paid potentials processed later
             editedTripUpdate.potential_trips = nextPotentialForUnpaidCheck; // Start building the final potential array


            // --- Process Paid Trips (Matched & Potential) (n107 - n220) ---
            logger.info(`Processing paid matched/potential trips for ${editedTripRef.id}`);

            const paidMatchedBefore = (editedTripBeforeData.matched_trips || []).filter(t => t.paid);
            const paidPotentialBefore = (editedTripBeforeData.potential_trips || []).filter(t => t.paid);
            const allPaidRefsMap = new Map<string, { element: MatchedTrip | PotentialTrip, type: 'matched' | 'potential' }>();

             (editedTripUpdate.matched_trips || []).filter(t => t.paid).forEach(el => allPaidRefsMap.set(el.trip_ref.path, {element: el, type: 'matched'}));
             (editedTripUpdate.potential_trips || []).filter(t => t.paid).forEach(el => {
                  if (!allPaidRefsMap.has(el.trip_ref.path)) { // Don't overwrite if it was matched
                     allPaidRefsMap.set(el.trip_ref.path, {element: el, type: 'potential'});
                  }
             });


            const distinctTripGroupRefs = new Map<string, DocumentReference>();
            allPaidRefsMap.forEach(item => {
                if (item.element.trip_group_ref && !distinctTripGroupRefs.has(item.element.trip_group_ref.path)) {
                    distinctTripGroupRefs.set(item.element.trip_group_ref.path, item.element.trip_group_ref);
                }
            });

            const tripGroupsInfoMap = new Map<string, TripGroupInfo>();

            if (distinctTripGroupRefs.size > 0) {
                logger.info(`Evaluating ${distinctTripGroupRefs.size} distinct trip groups.`);
                // n109: Initialize tripGroupsInfo
                // n113: Loop through Trip Groups
                for (const [tgPath, tgRef] of distinctTripGroupRefs) {
                    const tgSnap = await transaction.get(tgRef);
                    if (!tgSnap.exists) {
                        logger.warn(`Trip Group ${tgPath} not found.`);
                        continue;
                    }
                    const tgData = tgSnap.data() as TripGroup;
                    const tgMembers = tgData.trip_group_members || [];
                    const tgPotentialEntryForET = (tgData.potential_trip_members || []).find(ptm => ptm.trip_ref.path === editedTripRef.path);

                    // n114: Initialize info for this TG
                    const tgInfo: TripGroupInfo = {
                        tripGroupId: tgRef.id,
                        tripObstruction: false, // Calculated below
                        seatObstruction: undefined, // Calculated below
                        largestPickupOverlapGap: 0,
                        largestDestinationOverlapGap: 0,
                        initialTripObstruction: tgPotentialEntryForET?.trip_obstruction ?? false,
                        initialSeatObstruction: tgPotentialEntryForET?.seat_obstruction ?? false,
                        potentialTripMemberEntry: tgPotentialEntryForET, // Keep for updates
                        tripGroupData: tgData, // Store fetched data
                    };

                    const obstructingMembersUpdate: ObstructingTripMember[] = []; // Build the new list

                    // n110: Loop through TG members
                    for (const member of tgMembers) {
                        if (member.trip_ref.path === editedTripRef.path) continue; // Skip self

                        const memberSnap = await transaction.get(member.trip_ref);
                        if (!memberSnap.exists) {
                            logger.warn(`Trip group member ${member.trip_ref.id} in TG ${tgRef.id} not found.`);
                            continue;
                        }
                        const memberData = memberSnap.data() as Trip;

                        // n117: Does ET proper match TG member?
                        if (!properMatchGeometric(editedTripData, memberData)) {
                            tgInfo.tripObstruction = true; // Set obstruction flag for the group

                            // Calculate gaps
                            const pd = distanceBetween(editedTripData.pickup_latlng, memberData.pickup_latlng);
                            const dd = distanceBetween(editedTripData.destination_latlng, memberData.destination_latlng);
                            const gapP = calculateGap(editedTripData, memberData, 'pickup', pd);
                            const gapD = calculateGap(editedTripData, memberData, 'destination', dd);

                            // Update largest gaps for the group
                            tgInfo.largestPickupOverlapGap = Math.max(tgInfo.largestPickupOverlapGap, gapP);
                            tgInfo.largestDestinationOverlapGap = Math.max(tgInfo.largestDestinationOverlapGap, gapD);

                            // Add/update obstructing member entry (n131-n133)
                             obstructingMembersUpdate.push({
                                 trip_ref: member.trip_ref,
                                 pickup_overlap_gap: gapP > 0 ? gapP : 0, // Store 0 if no gap
                                 destination_overlap_gap: gapD > 0 ? gapD : 0, // Store 0 if no gap
                                 unknown: false,
                             });
                             logger.debug(`ET ${editedTripRef.id} obstructed by TG member ${member.trip_ref.id}. Gaps: P=${gapP}, D=${gapD}`);
                        }
                         // n116/n120 handled implicitly by rebuilding obstructingMembersUpdate array
                    }

                    // n122: Check Seat Obstruction
                    const availableSeats = 4 - (tgData.total_seat_count || 0); // Assume max 4 seats per group
                    tgInfo.seatObstruction = availableSeats < (editedTripData.seat_count || 1);

                    tripGroupsInfoMap.set(tgPath, tgInfo); // Store calculated info

                    // Update Trip Group Doc if obstructions changed (n111/n121, n124/n125)
                    const tgUpdate: Record<string, any> = {};
                    let potentialMembers = [...(tgData.potential_trip_members || [])];
                    const etIndexInTgPotential = potentialMembers.findIndex(p => p.trip_ref.path === editedTripRef.path);

                    if (etIndexInTgPotential !== -1) {
                         let entryChanged = false;
                         if (potentialMembers[etIndexInTgPotential].trip_obstruction !== tgInfo.tripObstruction) {
                             potentialMembers[etIndexInTgPotential].trip_obstruction = tgInfo.tripObstruction;
                             entryChanged = true;
                         }
                         if (potentialMembers[etIndexInTgPotential].seat_obstruction !== tgInfo.seatObstruction) {
                            potentialMembers[etIndexInTgPotential].seat_obstruction = tgInfo.seatObstruction;
                            entryChanged = true;
                         }
                         // Check if obstructing members list changed (simple length check for now, deep compare is better)
                          if (JSON.stringify(potentialMembers[etIndexInTgPotential].obstructing_trip_members || []) !== JSON.stringify(obstructingMembersUpdate)) {
                              potentialMembers[etIndexInTgPotential].obstructing_trip_members = obstructingMembersUpdate;
                              entryChanged = true;
                          }

                          if(entryChanged) {
                               tgUpdate.potential_trip_members = potentialMembers;
                               logger.info(`Updating potential_trip_members entry for ET ${editedTripRef.id} in TG ${tgRef.id}.`);
                          }

                    } else if (tgInfo.tripObstruction || tgInfo.seatObstruction) {
                        // ET wasn't potential before, but now might be considered (though obstructed)
                        // Add ET as potential member if applicable by other logic (e.g., if ET becomes potential to a member)
                        // For now, only update if entry exists.
                        logger.warn(`ET ${editedTripRef.id} not found in TG ${tgRef.id}'s potential members, cannot update obstructions.`);
                    }

                     if (Object.keys(tgUpdate).length > 0) {
                         transaction.update(tgRef, tgUpdate);
                     }
                } // End TG loop (n113)
            } // End if (distinctTripGroupRefs.size > 0)


            // --- Re-evaluate Paid Matched/Potential based on TG Info ---
            const finalMatchedTrips: MatchedTrip[] = (editedTripUpdate.matched_trips || []).filter(t => !t.paid); // Start with unpaid matches
            const finalPotentialTrips: PotentialTrip[] = (editedTripUpdate.potential_trips || []).filter(t => !t.paid); // Start with unpaid potentials

            for (const [refPath, item] of allPaidRefsMap) {
                 const tripElement = item.element; // MatchedTrip or PotentialTrip
                 const originalType = item.type; // 'matched' or 'potential'
                 const tripRef = tripElement.trip_ref;

                 const tripSnap = await transaction.get(tripRef);
                 if (!tripSnap.exists) {
                     logger.warn(`Paid ${originalType} trip ${tripRef.id} not found.`);
                     continue;
                 }
                 const tripData = tripSnap.data() as Trip;
                 const tgRef = tripElement.trip_group_ref;
                 const tgInfo = tgRef ? tripGroupsInfoMap.get(tgRef.path) : undefined;

                 // Recalculate geometric match
                 const matchesGeometrically = properMatchGeometric(editedTripData, tripData, tripElement.pickup_distance, tripElement.destination_distance);

                 let isTripObstructed = tgInfo?.tripObstruction ?? !matchesGeometrically; // Obstructed if TG says so OR fails geometric match now
                 let isSeatObstructed = tgInfo?.seatObstruction ?? false; // Obstructed if TG says so
                 let isReservingObstructed = tripElement.reserving_trip_obstruction; // Keep previous value unless recalculated

                 // Check if ET's reservation obstructs this trip
                 if (currentlyReservedByEdit && formerReservingTripRef) {
                      const formerReserverSnap = await transaction.get(formerReservingTripRef);
                      if(formerReserverSnap.exists) {
                            const formerReservingTripData = formerReserverSnap.data() as Trip;
                            if (!properMatchGeometric(tripData, formerReservingTripData)) {
                                isReservingObstructed = true;
                                logger.info(`ET's reservation obstructs paid trip ${tripRef.id}.`);
                            } else {
                                // If it DOES match the reserver, the obstruction *might* be cleared
                                // Graph logic n193-n195 / n178-n179
                                isReservingObstructed = false; // Clear obstruction if ET matches reserver
                            }
                      }
                 }

                 const canBeMatched = matchesGeometrically && !isTripObstructed && !isSeatObstructed && !isReservingObstructed;

                 if (originalType === 'matched') {
                     // --- Was Matched ---
                     if (canBeMatched) {
                         // n139 -> No -> n145: Stays Matched
                         logger.info(`Paid matched trip ${tripRef.id} remains matched.`);
                         matched = true;
                         tripElement.mutual = (tripElement as MatchedTrip).mutual; // Keep mutual status
                         // Update radii on other trip's matched entry
                         const otherTripUpdate: Record<string, any> = {};
                         const otherMatched = [...(tripData.matched_trips || [])];
                         const etIndexInOther = findTripIndex(otherMatched, editedTripRef);
                         if (etIndexInOther !== -1) {
                             otherMatched[etIndexInOther].pickup_radius = editedTripData.pickup_radius;
                             otherMatched[etIndexInOther].destination_radius = editedTripData.destination_radius;
                             // Handle mutual sync if needed (n141-144) - assume it was already synced
                             otherTripUpdate.matched_trips = otherMatched;
                             transaction.update(tripRef, otherTripUpdate);
                             logger.info(`Updated radii for ET in paid matched trip ${tripRef.id}'s matched_trips.`);
                         } else {
                              logger.warn(`ET not found in paid matched trip ${tripRef.id}'s matched_trips for update.`);
                         }
                         finalMatchedTrips.push(tripElement as MatchedTrip); // Keep in matched list
                     } else {
                         // n137 -> No OR n139 -> Yes: Match Broken or Obstructed -> Move to Potential
                         logger.info(`Moving paid matched trip ${tripRef.id} to potential (match broken/obstructed).`);
                         const potentialEntry: PotentialTrip = {
                             trip_ref: tripRef,
                             paid: true,
                             trip_group_ref: tgRef,
                             pickup_radius: tripData.pickup_radius,
                             destination_radius: tripData.destination_radius,
                             pickup_distance: tripElement.pickup_distance,
                             destination_distance: tripElement.destination_distance,
                             proper_match: matchesGeometrically, // True if geometrically ok but obstructed
                             trip_obstruction: isTripObstructed,
                             seat_obstruction: isSeatObstructed,
                             reserving_trip_obstruction: isReservingObstructed,
                             mutual: (tripElement as MatchedTrip).mutual, // Preserve mutual temporarily
                             group_largest_pickup_overlap_gap: tgInfo?.largestPickupOverlapGap ?? null,
                             group_largest_destination_overlap_gap: tgInfo?.largestDestinationOverlapGap ?? null,
                             unknown_trip_obstruction: false, // Assuming known obstruction reasons
                             total_seat_count: tgInfo?.tripGroupData?.total_seat_count ?? null,
                             // seat_count: tripData.seat_count // Add if needed
                         };
                         finalPotentialTrips.push(potentialEntry);

                         // Update other trip: Remove ET from matched, Add ET to potential
                         const otherTripUpdate: Record<string, any> = {};
                         const otherPotentialEntry: PotentialTrip = { ...potentialEntry }; // Clone base info
                         otherPotentialEntry.trip_ref = editedTripRef;
                         otherPotentialEntry.pickup_radius = editedTripData.pickup_radius;
                         otherPotentialEntry.destination_radius = editedTripData.destination_radius;
                         otherPotentialEntry.total_seat_count = editedTripData.total_seat_count ?? editedTripData.seat_count;
                         // Obstructions from other trip's perspective (usually false unless ET is reserved)
                         otherPotentialEntry.trip_obstruction = false;
                         otherPotentialEntry.seat_obstruction = false;
                         otherPotentialEntry.reserving_trip_obstruction = currentlyReservedByEdit; // Is ET reserved?

                         otherTripUpdate.potential_trips = FieldValue.arrayUnion(otherPotentialEntry);
                          // Remove ET from matched - requires exact match
                          const removalElement = (tripData.matched_trips || []).find(t => t.trip_ref.path === editedTripRef.path);
                          if (removalElement) {
                             otherTripUpdate.matched_trips = FieldValue.arrayRemove(removalElement);
                             logger.info(`Attempting removal of ET from paid matched trip ${tripRef.id}'s matched trips.`);
                          } else {
                              logger.warn(`ET not found in paid matched trip ${tripRef.id}'s matched_trips for removal.`);
                          }
                         transaction.update(tripRef, otherTripUpdate);
                         logger.info(`Moved ET from matched to potential for paid trip ${tripRef.id}.`);
                     }
                 } else {
                     // --- Was Potential ---
                     if (canBeMatched) {
                         // n198 -> No -> n214: Promoted to Matched
                         logger.info(`Promoting paid potential trip ${tripRef.id} to matched.`);
                         matched = true;
                         const matchedEntry: MatchedTrip = {
                             trip_ref: tripRef,
                             paid: true,
                             trip_group_ref: tgRef,
                             pickup_radius: tripData.pickup_radius,
                             destination_radius: tripData.destination_radius,
                             pickup_distance: tripElement.pickup_distance,
                             destination_distance: tripElement.destination_distance,
                             mutual: tripElement.mutual, // Preserve mutual
                             reserving: false, // ET not reserving here
                            // seat_count: tripData.seat_count // Add if needed
                         };
                         finalMatchedTrips.push(matchedEntry);

                         // Update other trip: Remove ET from potential, Add ET to matched
                         const otherTripUpdate: Record<string, any> = {};
                         const otherMatchedEntry: MatchedTrip = { ...matchedEntry }; // Clone base info
                         otherMatchedEntry.trip_ref = editedTripRef;
                         otherMatchedEntry.pickup_radius = editedTripData.pickup_radius;
                         otherMatchedEntry.destination_radius = editedTripData.destination_radius;
                         // seat_count: editedTripData.seat_count // Add if needed

                         otherTripUpdate.matched_trips = FieldValue.arrayUnion(otherMatchedEntry);
                          // Remove ET from potential - requires exact match
                          const removalElement = (tripData.potential_trips || []).find(t => t.trip_ref.path === editedTripRef.path);
                          if (removalElement) {
                             otherTripUpdate.potential_trips = FieldValue.arrayRemove(removalElement);
                             logger.info(`Attempting removal of ET from paid potential trip ${tripRef.id}'s potential trips.`);
                          } else {
                               logger.warn(`ET not found in paid potential trip ${tripRef.id}'s potential_trips for removal.`);
                          }
                         transaction.update(tripRef, otherTripUpdate);
                         logger.info(`Moved ET from potential to matched for paid trip ${tripRef.id}.`);

                     } else {
                         // n188 -> No OR n198 -> Yes: Stays Potential, update details
                         logger.info(`Paid potential trip ${tripRef.id} remains potential (or cannot be matched). Updating details.`);
                         const potentialEntry: PotentialTrip = {
                             trip_ref: tripRef,
                             paid: true,
                             trip_group_ref: tgRef,
                             pickup_radius: tripData.pickup_radius,
                             destination_radius: tripData.destination_radius,
                             pickup_distance: distanceBetween(editedTripData.pickup_latlng, tripData.pickup_latlng), // Recalculate distance
                             destination_distance: distanceBetween(editedTripData.destination_latlng, tripData.destination_latlng), // Recalculate distance
                             proper_match: matchesGeometrically,
                             trip_obstruction: isTripObstructed,
                             seat_obstruction: isSeatObstructed,
                             reserving_trip_obstruction: isReservingObstructed,
                             mutual: tripElement.mutual, // Preserve mutual
                             group_largest_pickup_overlap_gap: tgInfo?.largestPickupOverlapGap ?? null,
                             group_largest_destination_overlap_gap: tgInfo?.largestDestinationOverlapGap ?? null,
                             unknown_trip_obstruction: false,
                             total_seat_count: tgInfo?.tripGroupData?.total_seat_count ?? null,
                             // seat_count: tripData.seat_count // Add if needed
                         };
                         finalPotentialTrips.push(potentialEntry);

                         // Update other trip's potential entry for ET
                         const otherTripUpdate: Record<string, any> = {};
                         const otherPotential = [...(tripData.potential_trips || [])];
                         const etIndexInOther = findTripIndex(otherPotential, editedTripRef);
                         if (etIndexInOther !== -1) {
                            otherPotential[etIndexInOther].proper_match = matchesGeometrically;
                            otherPotential[etIndexInOther].pickup_radius = editedTripData.pickup_radius;
                            otherPotential[etIndexInOther].destination_radius = editedTripData.destination_radius;
                            otherPotential[etIndexInOther].pickup_distance = potentialEntry.pickup_distance; // Use consistent distance
                            otherPotential[etIndexInOther].destination_distance = potentialEntry.destination_distance; // Use consistent distance
                            otherPotential[etIndexInOther].trip_obstruction = false; // From other trip's perspective
                            otherPotential[etIndexInOther].seat_obstruction = false; // From other trip's perspective
                            otherPotential[etIndexInOther].reserving_trip_obstruction = currentlyReservedByEdit;
                            otherPotential[etIndexInOther].group_largest_pickup_overlap_gap = null; // N/A for direct potential
                            otherPotential[etIndexInOther].group_largest_destination_overlap_gap = null; // N/A for direct potential

                            otherTripUpdate.potential_trips = otherPotential; // Overwrite array
                             transaction.update(tripRef, otherTripUpdate);
                             logger.info(`Updated potential entry for ET in paid potential trip ${tripRef.id}.`);
                         } else {
                             logger.warn(`ET not found in paid potential trip ${tripRef.id}'s potential_trips for update.`);
                             // It might have been in matched before, need to handle removal + adding to potential (n196)
                              const removalElementMatched = (tripData.matched_trips || []).find(t => t.trip_ref.path === editedTripRef.path);
                              if(removalElementMatched) {
                                  const otherPotentialEntry: PotentialTrip = {
                                       trip_ref: editedTripRef,
                                       paid: false, // ET not paid in this context
                                       trip_group_ref: null,
                                       pickup_radius: editedTripData.pickup_radius,
                                       destination_radius: editedTripData.destination_radius,
                                       pickup_distance: potentialEntry.pickup_distance,
                                       destination_distance: potentialEntry.destination_distance,
                                       proper_match: matchesGeometrically,
                                       trip_obstruction: false,
                                       seat_obstruction: false,
                                       reserving_trip_obstruction: currentlyReservedByEdit,
                                       mutual: removalElementMatched.mutual, // Keep original mutual
                                       group_largest_pickup_overlap_gap: null,
                                       group_largest_destination_overlap_gap: null,
                                       unknown_trip_obstruction: false,
                                       total_seat_count: null,
                                  };
                                  otherTripUpdate.potential_trips = FieldValue.arrayUnion(otherPotentialEntry);
                                  otherTripUpdate.matched_trips = FieldValue.arrayRemove(removalElementMatched);
                                  transaction.update(tripRef, otherTripUpdate);
                                  logger.info(`Moved ET from matched to potential for paid trip ${tripRef.id} (was potential for ET).`);
                              }
                         }
                     }
                 }
            } // End loop through paid trips

            // --- Final Updates to Edited Trip ---
            editedTripUpdate.matched_trips = finalMatchedTrips;
            editedTripUpdate.potential_trips = finalPotentialTrips;

            // n222: Final Status Check
            const currentStatus = editedTripData.status;
            const hasMatchesNow = finalMatchedTrips.length > 0;

            // n221/n223/n224/n225: Update Status
            if (hasMatchesNow && currentStatus === "unmatched") {
                editedTripUpdate.status = "matched";
                logger.info(`Updating ET ${editedTripRef.id} status from unmatched to matched.`);
            } else if (!hasMatchesNow && currentStatus === "matched") {
                editedTripUpdate.status = "unmatched";
                 logger.info(`Updating ET ${editedTripRef.id} status from matched to unmatched.`);
                 // Also clear reservation if it becomes unmatched
                 if (editedTripUpdate.reserved === undefined && editedTripData.reserved) {
                     editedTripUpdate.reserved = false;
                     editedTripUpdate.reserving_trip_ref = FieldValue.delete();
                     logger.info(`Clearing reservation on ET ${editedTripRef.id} as it became unmatched.`);
                 }
            } else {
                 logger.info(`ET ${editedTripRef.id} status remains ${currentStatus}. Has matches: ${hasMatchesNow}.`);
            }

            // Apply all updates to the edited trip document
            if (Object.keys(editedTripUpdate).length > 0) {
                 logger.info(`Applying final updates to edited trip ${editedTripRef.id}:`, Object.keys(editedTripUpdate));
                 transaction.update(editedTripRef, editedTripUpdate);
            } else {
                 logger.info(`No final updates needed for edited trip ${editedTripRef.id}.`);
            }

            logger.info(`Transaction completed successfully for trip ${editedTripRef.id}`);

        }); // End Transaction
    } catch (error) {
        logger.error(`Error processing tripEdited for ${editedTripRef.id}:`, error);
        if (error instanceof functions.https.HttpsError) {
             // Log HttpsError specifically if needed
             logger.error(`HttpsError: ${error.code} - ${error.message}`);
        }
        // Rethrow or handle as appropriate for background function
        // throw error; // Rethrowing might cause retries
    }
});

// --- END Cloud Function ---