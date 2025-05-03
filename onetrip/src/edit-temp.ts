import * as functions from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import {
  onDocumentUpdated,
  FirestoreEvent,
  Change,
  QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import { FieldValue, DocumentReference } from "firebase-admin/firestore";
import {Trip, MatchedTrip, PotentialTrip, TripGroup, ObstructingTripMember, TripGroupInfo} from "../../type";
import { properMatchGeometric, updateNestedTripField, getStoredDistances, properMatchArrayCheck, calculateGap, customArrayUnion, checkMemberUnknownToTrip } from './utils/utils';
import { CloudTasksClient } from "@google-cloud/tasks";
import { MarkOptions } from "perf_hooks";

// Assuming admin SDK is initialized elsewhere
// admin.initializeApp();
const db = admin.firestore();
const tasksClient = new CloudTasksClient();
const TASKS_QUEUE_LOCATION = "us-central1"; // Or your function's region
const TASKS_QUEUE_ID = "reservation-cascade-queue"; // Choose a name
const TASKS_PROJECT_ID = process.env.GCLOUD_PROJECT || ''; // Get project ID automatically
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

    if (!beforeSnap?.exists || !afterSnap?.exists) {
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
        // editedTripBeforeData.pickup_latlng?.lat !== editedTripAfterData.pickup_latlng?.lat ||
        // editedTripBeforeData.pickup_latlng?.lng !== editedTripAfterData.pickup_latlng?.lng ||
        // editedTripBeforeData.destination_latlng?.lat !== editedTripAfterData.destination_latlng?.lat ||
        // editedTripBeforeData.destination_latlng?.lng !== editedTripAfterData.destination_latlng?.lng ||
        editedTripBeforeData.seat_count !== editedTripAfterData.seat_count
        // editedTripBeforeData.reserved !== editedTripAfterData.reserved || // Handle manual reservation changes?
        // editedTripBeforeData.reserving_trip_ref?.path !== editedTripAfterData.reserving_trip_ref?.path;

    const radiusChanged = editedTripBeforeData.pickup_radius !== editedTripAfterData.pickup_radius || editedTripBeforeData.destination_radius !== editedTripAfterData.destination_radius;

    const seatChanged = editedTripBeforeData.seat_count !== editedTripAfterData.seat_count;

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
            const editedTripUpdate: Partial<Trip> = {};
            editedTripUpdate.matched_trips = editedTripData.matched_trips || [] as MatchedTrip[]; // Start with current matched_trips
            editedTripUpdate.potential_trips = editedTripData.potential_trips || [] as PotentialTrip[]; // Start with current potential_trips

            // --- Reservation Handling (n4 - n28) ---
            const wasReservedBefore = editedTripBeforeData.reserved; //question: do i check before or after
            const formerReservingTripRef = editedTripBeforeData.reserving_trip_ref; // Ref before the update

            if (wasReservedBefore && formerReservingTripRef) {
                logger.info(`Trip ${editedTripRef.id} was reserved by ${formerReservingTripRef.id}. Checking match.`);
                const formerReservingTripSnap = await transaction.get(formerReservingTripRef);
                if (!formerReservingTripSnap.exists) {
                    logger.warn(`Former reserving trip ${formerReservingTripRef.id} not found. Cleaning up reservation on ${editedTripRef.id}.`);
                    // Clean up dangling reservation on edited trip
                    editedTripUpdate.reserved = false;
                    editedTripUpdate.reserving_trip_ref = FieldValue.delete() as any;
                    const formerReserverInMatchedIdx = findTripIndex(editedTripData.matched_trips, formerReservingTripRef);
                    if (formerReserverInMatchedIdx !== -1) {
                        // Ideally remove element, but FieldValue.arrayRemove needs exact object match
                        // Safer to reconstruct array or mark element for later removal logic outside transaction if complex
                        logger.warn(`Need to remove missing former reserver ${formerReservingTripRef.id} from matched_trips of ${editedTripRef.id}`);
                        editedTripUpdate.matched_trips.splice(formerReserverInMatchedIdx, 1); // Remove from matched_trips
                        // Potential simple fix: Overwrite array later if other changes occur
                        // For now, proceed assuming it might get handled by other logic moving it to potential
                    }
                    // Don't throw, just clean up and proceed with other checks
                } else {
                    const formerReservingTripData = formerReservingTripSnap.data() as Trip;

                    // n5: Does edited trip still proper match its *former* reserving trip?
                    let stillMatchesFormerReserver;
                    if (radiusChanged) {
                        const distance = getStoredDistances(editedTripData, formerReservingTripRef);
                        if (!distance) {
                            throw new Error(`Distance data not found for ${editedTripRef.id} and former reserver ${formerReservingTripRef.id}.`);
                        }
                        stillMatchesFormerReserver = properMatchGeometric(editedTripData, formerReservingTripData, distance?.pickupDistance, distance?.destinationDistance);
                    } else stillMatchesFormerReserver = properMatchArrayCheck(editedTripData, formerReservingTripData);

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
                        editedTripUpdate.reserving_trip_ref = FieldValue.delete() as any;

                        // Find and remove former reserving trip from edited trip's matched_trips
                        const reserverIndexInET = findTripIndex(editedTripUpdate.matched_trips, formerReservingTripRef);
                        if (reserverIndexInET !== -1) {
                            editedTripUpdate.matched_trips.splice(reserverIndexInET, 1); // Update the array
                            logger.info(`Removed former reserver ${formerReservingTripRef.id} from matched_trips of ${editedTripRef.id}.`);
                        } else {
                             logger.warn(`Former reserver ${formerReservingTripRef.id} not found in matched_trips of ${editedTripRef.id} for removal.`);
                        }

                        // n9: Update Former Reserving Trip
                        const formerReserverUpdate: Partial<Trip> = {};
                        formerReserverUpdate.matched_trips = [...(formerReservingTripData.matched_trips || [])];
                        formerReserverUpdate.potential_trips = [...(formerReservingTripData.potential_trips || [])]; // Start with current potential_trips
                        const etIndexInReserverMatched = findTripIndex(formerReserverUpdate.matched_trips, editedTripRef);
                        const etElementFromReserver: MatchedTrip | null = formerReserverUpdate.matched_trips[etIndexInReserverMatched];
                        if (etIndexInReserverMatched !== -1) {
                            formerReserverUpdate.matched_trips.splice(etIndexInReserverMatched, 1);

                            logger.info(`Removed ET ${editedTripRef.id} from matched_trips of former reserver ${formerReservingTripRef.id}.`);
                        } else {
                             logger.warn(`ET ${editedTripRef.id} not found in matched_trips of former reserver ${formerReservingTripRef.id} for removal.`);
                        }

                        // Add ET to former reserver's potential_trips
                        const pd = etElementFromReserver?.pickup_distance;
                        const dd = etElementFromReserver?.destination_distance;
                        if (!pd || !dd) {
                            logger.warn(`Pickup or destination distance missing for ET ${editedTripRef.id} in former reserver's matched_trips.`);
                            throw new Error(`Pickup or destination distance missing for ET ${editedTripRef.id} in former reserver's matched_trips.`);
                        }
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
                            seat_count: editedTripData.seat_count // Add if needed by schema
                        };
                        customArrayUnion(formerReserverUpdate.potential_trips, etPotentialEntryForReserver); // Use custom function to avoid duplicates
                        logger.info(`Adding ET ${editedTripRef.id} to potential_trips of former reserver ${formerReservingTripRef.id}.`);


                        // n10: Does former reserving trip have other matches left?
                        const hasOtherMatches = formerReserverUpdate.matched_trips.length > 0;

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
                                group_largest_pickup_overlap_gap: gapP !== null && gapP > 0 ? gapP : null,
                                group_largest_destination_overlap_gap: gapD !== null && gapD > 0 ? gapD : null,
                                unknown_trip_obstruction: false,
                                total_seat_count: formerReservingTripData.total_seat_count ?? formerReservingTripData.seat_count, // Use TG count if available
                                seat_count: formerReservingTripData.seat_count // Add if needed
                             };
                            // editedTripUpdate.matched_trips = editedTripUpdate.matched_trips?.filter(mt => mt.trip_ref?.path !== formerReservingTripRef.path); // Remove former reserving trip from matched_trips
                            customArrayUnion(editedTripUpdate.potential_trips, potentialEntryForET); // Use custom function to avoid duplicates
                            logger.info(`Adding former reserver ${formerReservingTripRef.id} to potential_trips of ET ${editedTripRef.id} (as paid).`);


                            // n16: Find new trip for former reserver to reserve
                            let nearestTripRef: DocumentReference | null = null;
                            let minCombinedDistance = Infinity;
                            let tiedRefs: DocumentReference[] = [];

                            for (const match of formerReserverUpdate.matched_trips) {
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
                                logger.warn(`Tie detected for new reservation target for ${formerReservingTripRef.id}. Picking random: ${nearestTripRef?.id}`);
                                // n19 -> n20 equivalent
                                const randomIndex = Math.floor(Math.random() * tiedRefs.length);
                                nearestTripRef = tiedRefs[randomIndex];
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
                                const newReserveeIndex = findTripIndex(formerReserverUpdate.matched_trips, nearestTripRef);
                                if (newReserveeIndex !== -1) {
                                     formerReserverUpdate.matched_trips[newReserveeIndex].reserving = true; // Update reserving field
                                     logger.info(`Updated former reserver ${formerReservingTripRef.id}: set reserving=true for match ${newlyReservedTripId}.`);

                                } else {
                                     logger.error(`Could not find new reservee ${newlyReservedTripId} in former reserver's matched_trips for update.`);
                                }

                                // n22-n28: Cascade effects of new reservation (Complex - requires fetching many potentially related trips)
                                // This part is highly complex and prone to exceeding transaction limits/read quotas.
                                // Consider deferring this to a separate triggered function or queue.
                                // For this implementation, we'll log the need but skip the deep cascade for brevity and stability.
                                logger.warn(`DEFERRED ACTION: Cascade updates (n22-n28) needed for trips related to ${newlyReservedTripId} due to new reservation by ${formerReservingTripRef.id}. Implement in a separate process.`);

                                 // *** DEFER n22-n28 using Cloud Tasks ***
                                const queuePath = tasksClient.queuePath(TASKS_PROJECT_ID, TASKS_QUEUE_LOCATION, "reservation-cascade-queue");
                                 const taskPayload = {
                                     newlyReservedTripPath: nearestTripRef.path,
                                     reservingTripPath: formerReservingTripRef.path,
                                };
                                const task = {
                                    httpRequest: {
                                        httpMethod: 'POST' as const,
                                        // URL of the handleReservationCascade HTTP function
                                        // Get this from `firebase functions:list` or construct it:
                                        // `https://${TASKS_QUEUE_LOCATION}-${TASKS_PROJECT_ID}.cloudfunctions.net/handleReservationCascade`
                                        // Needs service account with invoker role. For simplicity using OIDC token:
                                        url: `https://${TASKS_QUEUE_LOCATION}-${TASKS_PROJECT_ID}.cloudfunctions.net/handleReservationCascade`, // Replace with your function URL if different
                                        body: Buffer.from(JSON.stringify(taskPayload)).toString('base64'),
                                        headers: { 'Content-Type': 'application/json' },
                                        oidcToken: { // Use OIDC for authentication if function requires it
                                            serviceAccountEmail: process.env.FUNCTIONS_EMULATOR ? // Use default for emulator or deployed function's SA
                                                'firebase-auth-emulator@example.com' :
                                                `${TASKS_PROJECT_ID}@appspot.gserviceaccount.com`, // Replace if using a custom SA
                                        },
                                    },
                                    // Optional: scheduleTime, dispatchDeadline, etc.
                                    // scheduleTime: { seconds: Date.now() / 1000 + 60 } // Schedule 1 min in future
                                };

                                try {
                                    await tasksClient.createTask({ parent: queuePath, task });
                                    logger.info(`Enqueued reservation cascade task for newlyReserved: ${nearestTripRef.id}, reserver: ${formerReservingTripRef.id}`);
                                } catch (taskError) {
                                    logger.error(`Failed to enqueue reservation cascade task:`, taskError);
                                    // Decide if this should fail the transaction. Usually no, just log it.
                                }
                                // *** End Deferral ***

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
                                seat_count: formerReservingTripData.seat_count // Add if needed
                             };
                             customArrayUnion(editedTripUpdate.potential_trips, potentialEntryForETUnpaid); // Use custom function to avoid duplicates
                             logger.info(`Adding former reserver ${formerReservingTripRef.id} to potential_trips of ET ${editedTripRef.id} (as unpaid).`);


                            // n14: Update Former Reserving Trip status and fields
                            formerReserverUpdate.status = "unmatched";
                            formerReserverUpdate.trip_group_ref = FieldValue.delete() as any;
                            formerReserverUpdate.time_of_payment = FieldValue.delete() as any;
                            formerReserverUpdate.total_seat_count = FieldValue.delete() as any;
                            logger.info(`Updating former reserver ${formerReservingTripRef.id} to unmatched status.`);

                            // n18: Update trips that had former reserver as potential (paid)
                            // Again, complex cascade. Deferring.
                            const queuePathN18 = tasksClient.queuePath(TASKS_PROJECT_ID, TASKS_QUEUE_LOCATION, "potential-unmatch-cascade-queue"); // Use NEW queue ID
                            const taskPayloadN18 = {
                                formerReservingTripPath: formerReservingTripRef.path, // Send path of the trip that became unmatched
                            };
                            const taskN18 = {
                                httpRequest: {
                                    httpMethod: 'POST' as const,
                                    // URL of the NEW handlePotentialPaidUnmatchCascade HTTP function
                                    url: `https://${TASKS_QUEUE_LOCATION}-${TASKS_PROJECT_ID}.cloudfunctions.net/handlePotentialPaidUnmatchCascade`, // Adjust URL if needed
                                    body: Buffer.from(JSON.stringify(taskPayloadN18)).toString('base64'),
                                    headers: { 'Content-Type': 'application/json' },
                                    oidcToken: {
                                        serviceAccountEmail: process.env.FUNCTIONS_EMULATOR ?
                                            'firebase-auth-emulator@example.com' :
                                            `${TASKS_PROJECT_ID}@appspot.gserviceaccount.com`, // Use correct SA email
                                    },
                                },
                                // Optional: scheduleTime, etc.
                            };

                            try {
                                await tasksClient.createTask({ parent: queuePathN18, task: taskN18 });
                                logger.info(`Enqueued potential paid cascade task (n18) for former reserver: ${formerReservingTripRef.id}`);
                            } catch (taskError) {
                                logger.error(`Failed to enqueue potential paid cascade task (n18):`, taskError);
                                // Decide if this should fail the transaction. Usually no.
                            }
                            // *** End Deferral n18 ***
                        }
                         // Apply updates to the former reserving trip
                        transaction.update(formerReservingTripRef, formerReserverUpdate);
                    }
                }
            } // End if (wasReservedBefore && formerReservingTripRef)
            
            // --- Process Unpaid Matched Trips (n29 - n60) ---
            logger.info(`Processing unpaid matched trips for ${editedTripRef.id}`);
            const currentPotentialRefs = new Set((editedTripData.potential_trips || []).map(pt => pt.trip_ref.path)); // Track trips already potential
            
            // Use editedTripData.matched_trips for current state if reservation logic didn't modify it yet
            let currentMatchedForUnpaidCheck = editedTripData.matched_trips || [];
            
            for (const umtElement of currentMatchedForUnpaidCheck) {
                if (!editedTripUpdate.potential_trips) {
                    editedTripUpdate.potential_trips = [];
                }
                if (!editedTripUpdate.matched_trips) {
                    editedTripUpdate.matched_trips = [];
                }
                if (umtElement.paid) {
                    continue; // Only process unpaid here
                }
                
                const umtRef = umtElement.trip_ref;
                if (!umtRef) continue; // Skip if ref is missing
                const umtIndexInETMatched = findTripIndex(editedTripUpdate.matched_trips, umtRef);

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
                        if (umtData.trip_id === newlyReservedTripId) {
                            isObstructedByUMTReservation = true;
                            return; // Skip further checks, already handled in reservation logic
                        }
                        const umtReserverSnap = await transaction.get(umtData.reserving_trip_ref);
                        if (umtReserverSnap.exists) {
                            const umtReserverData = umtReserverSnap.data() as Trip;
                            const distances = getStoredDistances(editedTripData, umtData.reserving_trip_ref);
                            if (!distances || !properMatchGeometric(editedTripData, umtReserverData, distances?.pickupDistance, distances?.destinationDistance)) {
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
                        // ET matches UMT geometrically, but UMT's reservation causes conflict.

                        // --- Update ET: Move UMT to potential_trips ---
                        const originalMutual = umtElement.mutual; // Mutual status before this edit cycle

                        // Determine the new mutual status for the potential entry on ET's side
                        let newMutualForETPotential: boolean;
                        if (!originalMutual && currentlyReservedByEdit) {
                            // Case: Originally NOT mutual AND ET IS currently reserved
                            newMutualForETPotential = true;
                        } else {
                            // Case: Originally mutual OR (Originally NOT mutual AND ET is NOT currently reserved)
                            newMutualForETPotential = false;
                        }

                        const potentialEntryForET: PotentialTrip = {
                            trip_ref: umtRef,
                            paid: false,
                            trip_group_ref: null,
                            pickup_radius: umtData.pickup_radius,
                            destination_radius: umtData.destination_radius,
                            pickup_distance: umtElement.pickup_distance,
                            destination_distance: umtElement.destination_distance,
                            proper_match: true, // Matches geometrically
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: true, // Obstructed by UMT's reservation
                            mutual: newMutualForETPotential, // Set calculated mutual status
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                            seat_count: umtData.seat_count // Add if needed
                        };
                        // Use arrayUnion to add, avoids duplicates if somehow already there
                        customArrayUnion(editedTripUpdate.potential_trips, potentialEntryForET); // Use custom function to avoid duplicates
                        editedTripUpdate.matched_trips?.splice(umtIndexInETMatched, 1); // Remove from matched_trips
                        currentPotentialRefs.add(umtRef.path); // Track addition
                        logger.info(`Moved UMT ${umtRef.id} to potential for ET ${editedTripRef.id} due to reservation conflict (mutual set to ${newMutualForETPotential}).`);


                        // --- Update UMT based on original mutual status ---
                        const umtUpdate: Record<string, any> = {};

                        if (originalMutual) {
                            // UMT should have ET in its matched_trips. Update it there.
                            logger.info(`Updating ET's entry in UMT ${umtRef.id}'s matched_trips (original mutual was true).`);
                            const umtMatched = [...(umtData.matched_trips || [])];
                            const etIndexInUMTMatched = findTripIndex(umtMatched, editedTripRef);

                            if (etIndexInUMTMatched !== -1) {
                                // Update radii and set mutual to false
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUMTMatched, "pickup_radius", editedTripData.pickup_radius);
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUMTMatched, "destination_radius", editedTripData.destination_radius);
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUMTMatched, "mutual", false); // ET no longer sees UMT as matched
                                logger.info(`-- Updated radii and set mutual=false for ET ${editedTripRef.id} in UMT ${umtRef.id}'s matched_trips.`);
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s matched_trips for update, despite original mutual=true.`);
                                // Potential inconsistency, log it. Maybe it was already removed?
                            }
                        } else {
                            // Original mutual was false. UMT should have ET in its potential_trips.
                            logger.info(`Updating ET's entry in UMT ${umtRef.id}'s potential_trips (original mutual was false).`);
                            const umtPotential = [...(umtData.potential_trips || [])];
                            const etIndexInUMTPotential = findTripIndex(umtPotential, editedTripRef);

                            if (etIndexInUMTPotential !== -1) {
                                if (currentlyReservedByEdit) {
                                    // ET IS reserved. Update ET in UMT's potential, set mutual=true.
                                    logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii and setting mutual=true in UMT's potential_trips.`);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "pickup_radius", editedTripData.pickup_radius);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "destination_radius", editedTripData.destination_radius);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "mutual", true); // ET now also sees UMT as potential
                                } else {
                                    // ET is NOT reserved. Move ET from UMT's potential to matched, mutual=false.
                                    logger.info(`-- ET ${editedTripRef.id} is not reserved. Moving from potential to matched in UMT.`);
                                    const potentialElementToRemove = umtPotential[etIndexInUMTPotential]; // Get the exact element to remove

                                    const newMatchedEntryForUMT: MatchedTrip = {
                                        trip_ref: editedTripRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: editedTripData.pickup_radius, // Updated radii
                                        destination_radius: editedTripData.destination_radius, // Updated radii
                                        pickup_distance: potentialElementToRemove.pickup_distance, // Keep original distance
                                        destination_distance: potentialElementToRemove.destination_distance, // Keep original distance
                                        mutual: false, // As requested
                                        reserving: false,
                                        seat_count: editedTripData.seat_count // Add if needed
                                    };
                                    // Use atomic array operations
                                    umtUpdate.potential_trips = FieldValue.arrayRemove(potentialElementToRemove);
                                    umtUpdate.matched_trips = FieldValue.arrayUnion(newMatchedEntryForUMT);
                                    const umtMatchedBefore = umtData.matched_trips;
                                    if (umtMatchedBefore.length === 0) {
                                        // n43: Update UMT status to unmatched
                                        transaction.update(umtRef, { status: "matched" });
                                        logger.info(`Set UMT ${umtRef.id} status to matched.`);
                                    }
                                }
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s potential_trips for update, despite original mutual=false.`);
                                // Potential inconsistency.
                            }
                        }

                        // Apply updates to UMT if any changes were prepared
                        if (Object.keys(umtUpdate).length > 0) {
                            transaction.update(umtRef, umtUpdate);
                        } else {
                             logger.info(`-- No updates needed for UMT ${umtRef.id} based on ET ${editedTripRef.id}'s state.`);
                        }

                    } else { // This 'else' corresponds to 'if (isObstructedByUMTReservation)'
                         // ET matches UMT and is NOT obstructed by UMT's reservation.
                         // Original logic for this path (n48 ->) should remain here.
                         // Update radii on UMT's matched entry, handle mutual sync based on ET reservation.

                         logger.info(`ET ${editedTripRef.id} still matches UMT ${umtRef.id} and is not obstructed by reservation.`);
                         matched = true; // Remains matched from ET's perspective

                         // Update radii and potentially mutual on UMT's matched entry for ET
                         const umtUpdate: Record<string, any> = {};
                         const originalMutual = umtElement.mutual;

                         if (originalMutual) {
                            // UMT should have ET in its matched_trips. Update it there.
                            logger.info(`Updating ET's entry in UMT ${umtRef.id}'s matched_trips (original mutual was true).`);
                            const umtMatched = [...(umtData.matched_trips || [])];
                            const etIndexInUMTMatched = findTripIndex(umtMatched, editedTripRef);
                            
                            if (etIndexInUMTMatched !== -1) {
                                // Update radii and set mutual to false
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUMTMatched, "pickup_radius", editedTripData.pickup_radius);
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUMTMatched, "destination_radius", editedTripData.destination_radius);
                                logger.info(`-- Updated radii for ET ${editedTripRef.id} in UMT ${umtRef.id}'s matched_trips.`);
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s matched_trips for update, despite original mutual=true.`);
                                // Potential inconsistency, log it. Maybe it was already removed?
                            }
                        } else {
                            // Original mutual was false. UMT should have ET in its potential_trips.
                            logger.info(`Updating ET's entry in UMT ${umtRef.id}'s potential_trips (original mutual was false).`);
                            const umtPotential = [...(umtData.potential_trips || [])];
                            const etIndexInUMTPotential = findTripIndex(umtPotential, editedTripRef);
                            const umtIndexInETMatched = findTripIndex(currentMatchedForUnpaidCheck, umtRef)

                            if (etIndexInUMTPotential !== -1) {
                                if (currentlyReservedByEdit) {
                                    // ET IS reserved. Update ET in UMT's potential, set mutual=true.
                                    logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii in UMT's potential_trips.`);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "pickup_radius", editedTripData.pickup_radius);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "destination_radius", editedTripData.destination_radius);
                                } else {
                                    // ET is NOT reserved. Move ET from UMT's potential to matched, mutual=false.
                                    logger.info(`-- ET ${editedTripRef.id} is not reserved. Moving from potential to matched in UMT.`);
                                    const potentialElementToRemove = umtPotential[etIndexInUMTPotential]; // Get the exact element to remove

                                    const newMatchedEntryForUMT: MatchedTrip = {
                                        trip_ref: editedTripRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: editedTripData.pickup_radius, // Updated radii
                                        destination_radius: editedTripData.destination_radius, // Updated radii
                                        pickup_distance: potentialElementToRemove.pickup_distance, // Keep original distance
                                        destination_distance: potentialElementToRemove.destination_distance, // Keep original distance
                                        mutual: true, // As requested
                                        reserving: false,
                                        seat_count: editedTripData.seat_count // Add if needed
                                    };
                                    // Use atomic array operations
                                    umtUpdate.potential_trips = FieldValue.arrayRemove(potentialElementToRemove);
                                    umtUpdate.matched_trips = FieldValue.arrayUnion(newMatchedEntryForUMT);
                                    editedTripUpdate.matched_trips[umtIndexInETMatched].mutual = true; // Set mutual to true on ET's matched entry
                                    const umtMatchedBefore = umtData.matched_trips;
                                    if (umtMatchedBefore.length === 0) {
                                        // n43: Update UMT status to unmatched
                                        transaction.update(umtRef, { status: "matched" });
                                        logger.info(`Set UMT ${umtRef.id} status to matched.`);
                                    }
                                }
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s potential_trips for update, despite original mutual=false.`);
                                // Potential inconsistency.
                            }
                        }

                        // Apply updates to UMT if any changes were prepared
                        if (Object.keys(umtUpdate).length > 0) {
                            transaction.update(umtRef, umtUpdate);
                        } else {
                             logger.info(`-- No updates needed for UMT ${umtRef.id} based on ET ${editedTripRef.id}'s state.`);
                        }
                    }

                } else {
                    logger.info(`ET ${editedTripRef.id} NO LONGER matches unpaid trip ${umtRef.id}. Moving to potential.`);
                    // n32 -> Path: Move to potential on both sides
                    let isReservingTripObstruction = false;
                    // n33: Is UMT reserved?
                    if (umtData.reserved && umtData.reserving_trip_ref) {
                        // n34: Does ET proper match UMT's reserving trip?
                        if (umtData.reserving_trip_ref.id === newlyReservedTripId) {
                            isReservingTripObstruction = true;
                            return; // Skip further checks, already handled in reservation logic
                        }
                         const umtReserverSnap = await transaction.get(umtData.reserving_trip_ref);
                         if (umtReserverSnap.exists) {
                             const umtReserverData = umtReserverSnap.data() as Trip;
                             const distances = getStoredDistances(editedTripData, umtData.reserving_trip_ref);
                             if (!distances || !properMatchGeometric(editedTripData, umtReserverData, distances?.pickupDistance, distances?.destinationDistance)) {
                                 // n36: Set reserving_trip_obstruction on ET's potential entry
                                 isReservingTripObstruction = true;
                             }
                             // n35 if match is true
                         }
                         // n35 if reserver not found
                    }
                    // n35 if not reserved

                    const originalMutual = umtElement.mutual; // Mutual status before this edit cycle

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
                        seat_count: umtData.seat_count // Add if needed
                    };
                     customArrayUnion(editedTripUpdate.potential_trips, potentialEntryForET); // Use custom function to avoid duplicates
                     editedTripUpdate.matched_trips.splice(umtIndexInETMatched, 1); // Remove from matched_trips
                     currentPotentialRefs.add(umtRef.path); // Track addition
                     logger.info(`Moved UMT ${umtRef.id} from matched to potential for ET ${editedTripRef.id} (match broken).`);


                    // --- Update UMT based on original mutual status ---
                    const umtUpdate: Record<string, any> = {};

                    if (originalMutual) {
                        const umtMatched = [...(umtData.matched_trips || [])];
                        const etIndexInUMTMatched = findTripIndex(umtMatched, editedTripRef);
                        const potentialElementToRemove = umtMatched[etIndexInUMTMatched]; // Get the exact element to remove
                        // UMT should have ET in its matched_trips. Update it there.
                        const potentialEntryForUMT: PotentialTrip = {
                            trip_ref: editedTripRef,
                            paid: false,
                            trip_group_ref: null,
                            pickup_radius: editedTripData.pickup_radius,
                            destination_radius: editedTripData.destination_radius,
                            pickup_distance: potentialElementToRemove.pickup_distance,
                            destination_distance: potentialElementToRemove.destination_distance,
                            proper_match: false, // Matches geometrically
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: false,
                            mutual: true, // Set calculated mutual status
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                            seat_count: editedTripData.seat_count // Add if needed
                        };
                        // Use arrayUnion to add, avoids duplicates if somehow already there
                        umtUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForUMT) as any;
                        umtUpdate.matched_trips = FieldValue.arrayRemove(potentialElementToRemove) as any; // Remove from matched_trips
                        logger.info(`Moved ET ${editedTripData.trip_id} to potential for ET ${umtRef.id} due to proper match conflict).`);

                        // n42: Was ET the only match for UMT?
                        const umtMatchedBefore = (umtData.matched_trips || []).filter(t => t.trip_ref.path !== editedTripRef.path);
                        if (umtMatchedBefore.length === 0) {
                            // n43: Update UMT status to unmatched
                            transaction.update(umtRef, { status: "unmatched" });
                            logger.info(`Set UMT ${umtRef.id} status to unmatched.`);
                        }

                    } else {
                        // Original mutual was false. UMT should have ET in its potential_trips.
                        logger.info(`Updating ET's entry in UMT ${umtRef.id}'s potential_trips (original mutual was false).`);
                        const umtPotential = [...(umtData.potential_trips || [])];
                        const etIndexInUMTPotential = findTripIndex(umtPotential, editedTripRef);

                        if (etIndexInUMTPotential !== -1) {
                            // ET IS reserved. Update ET in UMT's potential, set mutual=true.
                            logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii and setting mutual=true in UMT's potential_trips.`);
                            updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "pickup_radius", editedTripData.pickup_radius);
                            updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "destination_radius", editedTripData.destination_radius);
                            updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "proper_match", false); // Match broken
                            updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "mutual", true); // ET now also sees UMT as potential
                            updateNestedTripField(umtUpdate, "potential_trips", etIndexInUMTPotential, "reserving_trip_obstruction", currentlyReservedByEdit ? true : false); // No longer obstructed by ET's reservation
                        } else {
                            logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${umtRef.id}'s potential_trips for update, despite original mutual=false.`);
                            // Potential inconsistency.
                        }
                    }

                    // Apply updates to UMT if any changes were prepared
                    if (Object.keys(umtUpdate).length > 0) {
                        transaction.update(umtRef, umtUpdate);
                    } else {
                         logger.info(`-- No updates needed for UMT ${umtRef.id} based on ET ${editedTripRef.id}'s state.`);
                    }
                }
                // n60: Loop continues implicitly
            }
            // --- Process Unpaid Potential Trips (n61 - n106) ---
            logger.info(`Processing unpaid potential trips for ${editedTripRef.id}`);
            const potentialTripsToEvaluate = editedTripAfterData.potential_trips || [];

            const currentMatchedRefs = new Set((editedTripUpdate.matched_trips || []).map(mt => mt.trip_ref.path));
            const nextPotentialForUnpaidCheck: PotentialTrip[] = []; // Build the next state

            for (const uptElement of potentialTripsToEvaluate) {
                if (!editedTripUpdate.potential_trips) {
                    editedTripUpdate.potential_trips = [];
                }
                if (!editedTripUpdate.matched_trips) {
                    editedTripUpdate.matched_trips = [];
                }
                 if (uptElement.paid) {
                      nextPotentialForUnpaidCheck.push(uptElement); // Keep paid potentials for now
                      continue; // Only process unpaid here
                 }
                 if (currentMatchedRefs.has(uptElement.trip_ref.path)) {
                     continue; // Skip if it got moved to matched already
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
                const uptIndexInETPotential = findTripIndex(potentialTripsToEvaluate, uptRef); // Get the index of UPT in ET's potential_trips
                
                if (matchesUPT) {
                    logger.info(`ET ${editedTripRef.id} still matches unpaid trip ${uptRef.id}.`);
                    // n44 -> Path: Check UMT reservation status
                    let isObstructedByUPTReservation = false;
                    // n45: Is UMT reserved?
                    if (uptData.reserved && uptData.reserving_trip_ref) {
                        // n47: Does ET proper match UMT's reserving trip?
                        if (uptData.trip_id === newlyReservedTripId) {
                            isObstructedByUPTReservation = true;
                            return; // Skip further checks, already handled in reservation logic
                        }
                        const umtReserverSnap = await transaction.get(uptData.reserving_trip_ref);
                        if (umtReserverSnap.exists) {
                            const uptReserverData = umtReserverSnap.data() as Trip;
                            const distances = getStoredDistances(editedTripData, uptData.reserving_trip_ref);
                            if (!distances || !properMatchGeometric(editedTripData, uptReserverData, distances?.pickupDistance, distances?.destinationDistance)) {
                                logger.info(`ET ${editedTripRef.id} does NOT match UMT ${uptRef.id}'s reserver ${uptData.reserving_trip_ref.id}.`);
                                // n46: Conflict. Move UMT to ET's potential.
                                isObstructedByUPTReservation = true;
                            } else {
                                // n48: ET matches UMT's reserver. OK to proceed.
                                logger.info(`ET ${editedTripRef.id} matches UMT ${uptRef.id}'s reserver ${uptData.reserving_trip_ref.id}.`);
                                matched = true; // Remains matched
                            }
                        } else {
                             logger.warn(`UMT ${uptRef.id}'s reserving trip ${uptData.reserving_trip_ref.id} not found. Treating as not obstructed.`);
                             matched = true; // Remains matched
                        }
                    } else {
                        // n45 -> No -> n48: UMT not reserved. OK to proceed.
                        logger.info(`UMT ${uptRef.id} is not reserved.`);
                        matched = true; // Remains matched
                    }

                    if (isObstructedByUPTReservation) {
                        // ET matches UMT geometrically, but UMT's reservation causes conflict.

                        // --- Update ET: Move UMT to potential_trips ---
                        const originalMutual = uptElement.mutual; // Mutual status before this edit cycle

                        // Determine the new mutual status for the potential entry on ET's side
                        let newMutualForETPotential: boolean;
                        if (!originalMutual && currentlyReservedByEdit) {
                            // Case: Originally NOT mutual AND ET IS currently reserved
                            newMutualForETPotential = true;
                        } else {
                            // Case: Originally mutual OR (Originally NOT mutual AND ET is NOT currently reserved)
                            newMutualForETPotential = false;
                        }

                        editedTripUpdate.potential_trips[uptIndexInETPotential].reserving_trip_obstruction = true; // Set trip_obstruction to true
                        currentPotentialRefs.add(uptRef.path); // Track addition
                        logger.info(`Moved UMT ${uptRef.id} to potential for ET ${editedTripRef.id} due to reservation conflict (mutual set to ${newMutualForETPotential}).`);


                        // --- Update UMT based on original mutual status ---
                        const umtUpdate: Record<string, any> = {};

                        if (!originalMutual) {
                            // UPT should have ET in its matched_trips. Update it there.
                            logger.info(`Updating ET's entry in UMT ${uptRef.id}'s matched_trips (original mutual was true).`);
                            const uptMatched = [...(uptData.matched_trips || [])];
                            const etIndexInUPTMatched = findTripIndex(uptMatched, editedTripRef);

                            if (etIndexInUPTMatched !== -1) {
                                // Update radii and set mutual to false
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUPTMatched, "pickup_radius", editedTripData.pickup_radius);
                                updateNestedTripField(umtUpdate, "matched_trips", etIndexInUPTMatched, "destination_radius", editedTripData.destination_radius);
                                // updateNestedTripField(umtUpdate, "matched_trips", etIndexInUPTMatched, "mutual", false); // ET no longer sees UPT as matched
                                logger.info(`-- Updated radii and set mutual=false for ET ${editedTripRef.id} in UMT ${uptRef.id}'s matched_trips.`);
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${uptRef.id}'s matched_trips for update, despite original mutual=true.`);
                                // Potential inconsistency, log it. Maybe it was already removed?
                            }
                        } else {
                            // Original mutual was true. UPT should have ET in its potential_trips.
                            logger.info(`Updating ET's entry in UPT ${uptRef.id}'s potential_trips (original mutual was true).`);
                            const uptPotential = [...(uptData.potential_trips || [])];
                            const etIndexInUPTPotential = findTripIndex(uptPotential, editedTripRef);

                            if (etIndexInUPTPotential !== -1) {
                                if (currentlyReservedByEdit && uptElement.reserving_trip_obstruction) {
                                    // ET IS reserved. Update ET in UPT's potential, set mutual=true.
                                    logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii and setting mutual=true in UPT's potential_trips.`);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUPTPotential, "pickup_radius", editedTripData.pickup_radius);
                                    updateNestedTripField(umtUpdate, "potential_trips", etIndexInUPTPotential, "destination_radius", editedTripData.destination_radius);
                                    // updateNestedTripField(umtUpdate, "potential_trips", etIndexInUPTPotential, "mutual", true); // ET now also sees UPT as potential
                                } else {
                                    // ET is NOT reserved. Move ET from UPT's potential to matched, mutual=false.
                                    logger.info(`-- ET ${editedTripRef.id} is not reserved. Moving from potential to matched in UPT.`);
                                    const potentialElementToRemove = uptPotential[etIndexInUPTPotential]; // Get the exact element to remove

                                    const newMatchedEntryForUPT: MatchedTrip = {
                                        trip_ref: editedTripRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: editedTripData.pickup_radius, // Updated radii
                                        destination_radius: editedTripData.destination_radius, // Updated radii
                                        pickup_distance: potentialElementToRemove.pickup_distance, // Keep original distance
                                        destination_distance: potentialElementToRemove.destination_distance, // Keep original distance
                                        mutual: false, // As requested
                                        reserving: false,
                                        seat_count: editedTripData.seat_count // Add if needed
                                    };
                                    // Use atomic array operations
                                    umtUpdate.potential_trips = FieldValue.arrayRemove(potentialElementToRemove);
                                    umtUpdate.matched_trips = FieldValue.arrayUnion(newMatchedEntryForUPT);
                                    const uptMatchedBefore = uptData.matched_trips;
                                    if (uptMatchedBefore.length === 0) {
                                        // n43: Update UPT status to matched
                                        transaction.update(uptRef, { status: "matched" });
                                        logger.info(`Set UPT ${uptRef.id} status to matched.`);
                                    }
                                }
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${uptRef.id}'s potential_trips for update, despite original mutual=false.`);
                                // Potential inconsistency.
                            }
                        }

                        // Apply updates to UMT if any changes were prepared
                        if (Object.keys(umtUpdate).length > 0) {
                            transaction.update(uptRef, umtUpdate);
                        } else {
                             logger.info(`-- No updates needed for UMT ${uptRef.id} based on ET ${editedTripRef.id}'s state.`);
                        }

                    } else { // This 'else' corresponds to 'if (isObstructedByUMTReservation)'
                         // ET matches UPT and is NOT obstructed by UPT's reservation.
                         // Original logic for this path (n48 ->) should remain here.
                         // Update radii on UPT's matched entry, handle mutual sync based on ET reservation.

                         logger.info(`ET ${editedTripRef.id} still matches UPT ${uptRef.id} and is not obstructed by reservation.`);
                         matched = true; // Remains matched from ET's perspective

                         // Update radii and potentially mutual on UMT's matched entry for ET
                         const uptUpdate: Record<string, any> = {};
                         const originalMutual = uptElement.mutual;

                         if (!originalMutual) {
                            // UMT should have ET in its matched_trips. Update it there.
                            logger.info(`Updating ET's entry in UMT ${uptRef.id}'s matched_trips (original mutual was true).`);
                            const uptMatched = [...(uptData.matched_trips || [])];
                            const etIndexInUMTMatched = findTripIndex(uptMatched, editedTripRef);
                            
                            if (etIndexInUMTMatched !== -1) {
                                // Update radii and set mutual to false
                                updateNestedTripField(uptUpdate, "matched_trips", etIndexInUMTMatched, "pickup_radius", editedTripData.pickup_radius);
                                updateNestedTripField(uptUpdate, "matched_trips", etIndexInUMTMatched, "destination_radius", editedTripData.destination_radius);
                                logger.info(`-- Updated radii for ET ${editedTripRef.id} in UMT ${uptRef.id}'s matched_trips.`);

                                const newMatchedEntryForET: MatchedTrip = {
                                    trip_ref: uptRef,
                                    paid: false,
                                    trip_group_ref: null,
                                    pickup_radius: uptData.pickup_radius, // Updated radii
                                    destination_radius: uptData.destination_radius, // Updated radii
                                    pickup_distance: uptElement.pickup_distance, // Keep original distance
                                    destination_distance: uptElement.destination_distance, // Keep original distance
                                    mutual: true, // As requested
                                    reserving: false,
                                    seat_count: uptData.seat_count // Add if needed
                                }

                                customArrayUnion(editedTripUpdate.matched_trips, newMatchedEntryForET); // Use custom function to avoid duplicates
                                editedTripUpdate.potential_trips?.splice(uptIndexInETPotential, 1); // Remove from potential_trips
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${uptRef.id}'s matched_trips for update, despite original mutual=true.`);
                                // Potential inconsistency, log it. Maybe it was already removed?
                            }
                        } else {
                            // Original mutual was true. UPT should have ET in its potential_trips.
                            logger.info(`Updating ET's entry in UPT ${uptRef.id}'s potential_trips (original mutual was true).`);
                            const uptPotential = [...(uptData.potential_trips || [])];
                            const etIndexInUPTPotential = findTripIndex(uptPotential, editedTripRef);

                            if (etIndexInUPTPotential !== -1) {
                                if (currentlyReservedByEdit && uptElement.reserving_trip_obstruction) {
                                    // ET IS reserved. Update ET in UMT's potential, set mutual=true.
                                    logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii in UPT's potential_trips.`);
                                    updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "pickup_radius", editedTripData.pickup_radius);
                                    updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "destination_radius", editedTripData.destination_radius);
                                    updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "mutual", false); // ET sees UMT as matched

                                    const newMatchedEntryForET: MatchedTrip = {
                                        trip_ref: uptRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: uptData.pickup_radius, // Updated radii
                                        destination_radius: uptData.destination_radius, // Updated radii
                                        pickup_distance: uptElement.pickup_distance, // Keep original distance
                                        destination_distance: uptElement.destination_distance, // Keep original distance
                                        mutual: false, // As requested
                                        reserving: false,
                                        seat_count: uptData.seat_count // Add if needed
                                    }

                                    customArrayUnion(editedTripUpdate.matched_trips, newMatchedEntryForET); // Use custom function to avoid duplicates
                                    editedTripUpdate.potential_trips?.splice(uptIndexInETPotential, 1); // Remove from potential_trips
                                } else {
                                    // ET is NOT reserved. Move ET from UPT's potential to matched, mutual=true.
                                    logger.info(`-- ET ${editedTripRef.id} is not reserved. Moving from potential to matched in UPT.`);
                                    const potentialElementToRemove = uptPotential[etIndexInUPTPotential]; // Get the exact element to remove

                                    const newMatchedEntryForUPT: MatchedTrip = {
                                        trip_ref: editedTripRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: editedTripData.pickup_radius, // Updated radii
                                        destination_radius: editedTripData.destination_radius, // Updated radii
                                        pickup_distance: potentialElementToRemove.pickup_distance, // Keep original distance
                                        destination_distance: potentialElementToRemove.destination_distance, // Keep original distance
                                        mutual: true, // As requested
                                        reserving: false,
                                        seat_count: editedTripData.seat_count // Add if needed
                                    };
                                    // Use atomic array operations
                                    uptUpdate.potential_trips = FieldValue.arrayRemove(potentialElementToRemove);
                                    uptUpdate.matched_trips = FieldValue.arrayUnion(newMatchedEntryForUPT);
                                    const uptMatchedBefore = uptData.matched_trips
                                    if (uptMatchedBefore.length === 0) {
                                        // n43: Update UMT status to unmatched
                                        transaction.update(uptRef, { status: "matched" });
                                        logger.info(`Set UPT ${uptRef.id} status to matched.`);
                                    }

                                    const newMatchedEntryForET: MatchedTrip = {
                                        trip_ref: uptRef,
                                        paid: false,
                                        trip_group_ref: null,
                                        pickup_radius: uptData.pickup_radius, // Updated radii
                                        destination_radius: uptData.destination_radius, // Updated radii
                                        pickup_distance: uptElement.pickup_distance, // Keep original distance
                                        destination_distance: uptElement.destination_distance, // Keep original distance
                                        mutual: true, // As requested
                                        reserving: false,
                                        seat_count: uptData.seat_count // Add if needed
                                    }

                                    customArrayUnion(editedTripUpdate.matched_trips, newMatchedEntryForET); // Use custom function to avoid duplicates
                                    editedTripUpdate.potential_trips?.splice(uptIndexInETPotential, 1); // Remove from potential_trips
                                }
                            } else {
                                logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${uptRef.id}'s potential_trips for update, despite original mutual=false.`);
                                // Potential inconsistency.
                            }
                        }

                        // Apply updates to UMT if any changes were prepared
                        if (Object.keys(uptUpdate).length > 0) {
                            transaction.update(uptRef, uptUpdate);
                        } else {
                             logger.info(`-- No updates needed for UMT ${uptRef.id} based on ET ${editedTripRef.id}'s state.`);
                        }
                    }

                } else {
                    logger.info(`ET ${editedTripRef.id} DOES NOT match unpaid trip ${uptRef.id}. Staying in potential.`);
                    // n32 -> Path: Move to potential on both sides
                    let isReservingTripObstruction = false;
                    // n33: Is UPT reserved?
                    if (uptData.reserved && uptData.reserving_trip_ref) {
                        // n34: Does ET proper match UPT's reserving trip?
                        if (uptData.trip_id === newlyReservedTripId) {
                            isReservingTripObstruction = true;
                            return; // Skip further checks, already handled in reservation logic
                        }
                         const uptReserverSnap = await transaction.get(uptData.reserving_trip_ref);
                         if (uptReserverSnap.exists) {
                             const uptReserverData = uptReserverSnap.data() as Trip;
                             const distances = getStoredDistances(editedTripData, uptData.reserving_trip_ref);
                             if (!distances || !properMatchGeometric(editedTripData, uptReserverData, distances?.pickupDistance, distances?.destinationDistance)) {
                                 // n36: Set reserving_trip_obstruction on ET's potential entry
                                 isReservingTripObstruction = true;
                             }
                             // n35 if match is true
                         }
                         // n35 if reserver not found
                    }
                    // n35 if not reserved

                    const originalMutual = uptElement.mutual; // Mutual status before this edit cycle

                    // Add UMT to ET's potential (n35/n36)
                     editedTripUpdate.potential_trips[uptIndexInETPotential].proper_match = false; // Set trip_obstruction to true   
                     currentPotentialRefs.add(uptRef.path); // Track addition
                     logger.info(`Updated UPT ${uptRef.id} in potential for ET ${editedTripRef.id} (match broken).`);


                    // --- Update UMT based on original mutual status ---
                    const uptUpdate: Record<string, any> = {};

                    if (!originalMutual) {
                        const uptMatched = [...(uptData.matched_trips || [])];
                        const etIndexInUPTMatched = findTripIndex(uptMatched, editedTripRef);
                        const potentialElementToRemove = uptMatched[etIndexInUPTMatched]; // Get the exact element to remove
                        // UMT should have ET in its matched_trips. Update it there.
                        const potentialEntryForUPT: PotentialTrip = {
                            trip_ref: editedTripRef,
                            paid: false,
                            trip_group_ref: null,
                            pickup_radius: editedTripData.pickup_radius,
                            destination_radius: editedTripData.destination_radius,
                            pickup_distance: potentialElementToRemove.pickup_distance,
                            destination_distance: potentialElementToRemove.destination_distance,
                            proper_match: false, // Matches geometrically
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: false,
                            mutual: true, // Set calculated mutual status
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                            seat_count: editedTripData.seat_count // Add if needed
                        };
                        // Use arrayUnion to add, avoids duplicates if somehow already there
                        uptUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForUPT) as any;
                        uptUpdate.matched_trips = FieldValue.arrayRemove(potentialElementToRemove) as any; // Remove from matched_trips
                        logger.info(`Moved ET ${editedTripData.trip_id} to potential for UPT ${uptRef.id} due to proper match conflict).`);

                        // n42: Was ET the only match for UMT?
                        const uptMatchedBefore = (uptData.matched_trips || []).filter(t => t.trip_ref.path !== editedTripRef.path);
                        if (uptMatchedBefore.length === 0) {
                            // n43: Update UMT status to unmatched
                            transaction.update(uptRef, { status: "unmatched" });
                            logger.info(`Set UMT ${uptRef.id} status to unmatched.`);
                        }

                    } else {
                        // Original mutual was true. UPT should have ET in its potential_trips.
                        logger.info(`Updating ET's entry in UPT ${uptRef.id}'s potential_trips (original mutual was false).`);
                        const uptPotential = [...(uptData.potential_trips || [])];
                        const etIndexInUPTPotential = findTripIndex(uptPotential, editedTripRef);

                        if (etIndexInUPTPotential !== -1) {
                            // ET IS reserved. Update ET in UMT's potential, set mutual=true.
                            logger.info(`-- ET ${editedTripRef.id} is reserved. Updating radii and setting mutual=true in UMT's potential_trips.`);
                            updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "pickup_radius", editedTripData.pickup_radius);
                            updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "destination_radius", editedTripData.destination_radius);
                            updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "proper_match", false); // Match broken
                            updateNestedTripField(uptUpdate, "potential_trips", etIndexInUPTPotential, "reserving_trip_obstruction", currentlyReservedByEdit ? true : false); // No longer obstructed by ET's reservation
                        } else {
                            logger.warn(`-- ET ${editedTripRef.id} not found in UMT ${uptRef.id}'s potential_trips for update, despite original mutual=false.`);
                            // Potential inconsistency.
                        }
                    }

                    // Apply updates to UMT if any changes were prepared
                    if (Object.keys(uptUpdate).length > 0) {
                        transaction.update(uptRef, uptUpdate);
                    } else {
                         logger.info(`-- No updates needed for UMT ${uptRef.id} based on ET ${editedTripRef.id}'s state.`);
                    }
                }
                // n60: Loop continues implicitly
            }
             // Update the edited trip's potential_trips array after processing unpaid ones
             // Combine with paid potentials processed later

            // --- Process Paid Trips (Matched & Potential) (n107 - n220) ---
            logger.info(`Processing paid matched/potential trips for ${editedTripRef.id}`);

            const paidMatchedBefore = (editedTripBeforeData.matched_trips || []).filter(t => t.paid);
            const paidPotentialBefore = (editedTripBeforeData.potential_trips || []).filter(t => t.paid);
            const allPaidRefsMap = new Map<string, { element: MatchedTrip | PotentialTrip, type: 'matched' | 'potential' }>();

             (editedTripData.matched_trips || []).filter(t => t.paid).forEach(el => allPaidRefsMap.set(el.trip_ref.path, {element: el, type: 'matched'}));
             (editedTripData.potential_trips || []).filter(t => t.paid).forEach(el => {
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
                        if (await checkMemberUnknownToTrip(editedTripData, memberData)) {
                            logger.info(`Member ${member.trip_ref.id} is unknown to ET ${editedTripRef.id}.`);
                            tgInfo.tripObstruction = true; // Set obstruction flag for the group
                            continue; // Skip if unknown to ET
                        }
                        // n117: Does ET proper match TG member?
                        const distances = getStoredDistances(editedTripData, member.trip_ref);
                        if (!distances) {
                            logger.warn(`Distances not found for ET ${editedTripRef.id} and TG member ${member.trip_ref.id}.`);
                            continue; // Skip if distances not found
                        }
                        if (!properMatchGeometric(editedTripData, memberData, distances?.pickupDistance, distances?.destinationDistance)) {
                            tgInfo.tripObstruction = true; // Set obstruction flag for the group

                            // Calculate gaps
                            const pd = distances.pickupDistance;
                            const dd = distances.destinationDistance;
                            const gapP = calculateGap(editedTripData, memberData, 'pickup', pd);
                            const gapD = calculateGap(editedTripData, memberData, 'destination', dd);

                            // Update largest gaps for the group
                            tgInfo.largestPickupOverlapGap = Math.max(tgInfo.largestPickupOverlapGap, gapP ? gapP : 0);
                            tgInfo.largestDestinationOverlapGap = Math.max(tgInfo.largestDestinationOverlapGap, gapD ? gapD : 0);

                            // Add/update obstructing member entry (n131-n133)
                             obstructingMembersUpdate.push({
                                 trip_ref: member.trip_ref,
                                 pickup_overlap_gap: gapP ? (gapP > 0 ? gapP : 0) : 0, // Store 0 if no gap
                                 destination_overlap_gap: gapD ? (gapD > 0 ? gapD : 0) : 0, // Store 0 if no gap
                                 unknown: false,
                             });
                             logger.debug(`ET ${editedTripRef.id} obstructed by TG member ${member.trip_ref.id}. Gaps: P=${gapP}, D=${gapD}`);
                        }
                         // n116/n120 handled implicitly by rebuilding obstructingMembersUpdate array
                    }

                    // n122: Check Seat Obstruction
                    const availableSeats = 4 - (tgData.total_seat_count || 0); // Assume max 4 seats per group
                    tgInfo.seatObstruction = availableSeats < editedTripData.seat_count;

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
                 const otherPotential = [...(tripData.potential_trips || [])];
                 const etIndexInOtherPotential = findTripIndex(otherPotential, editedTripRef);
                 let isReservingObstructed = tripData.potential_trips[etIndexInOtherPotential].reserving_trip_obstruction && currentlyReservedByEdit; // Keep previous value unless recalculated

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
                         const otherIndexInETMatched = findTripIndex(editedTripUpdate.matched_trips, tripRef);
                         const etIndexInOtherPotential = findTripIndex(otherPotential, editedTripRef);
                         if (tripElement.mutual) {
                            if (etIndexInOther !== -1) {
                                otherMatched[etIndexInOther].pickup_radius = editedTripData.pickup_radius;
                                otherMatched[etIndexInOther].destination_radius = editedTripData.destination_radius;
                                otherTripUpdate.matched_trips = otherMatched;
                            } else { 
                                logger.warn(`ET not found in paid matched trip ${tripRef.id}'s matched_trips for update.`);
                            }
                         } else {
                            const matchedEntryForOther: MatchedTrip = {
                                trip_ref: editedTripRef,
                                paid: false,
                                trip_group_ref: null,
                                pickup_radius: editedTripData.pickup_radius,
                                destination_radius: editedTripData.destination_radius,
                                pickup_distance: tripElement.pickup_distance, // Keep original distance
                                destination_distance: tripElement.destination_distance, // Keep original distance
                                mutual: true, // As requested
                                reserving: false,
                                seat_count: editedTripData.seat_count // Add if needed
                                };
                            otherTripUpdate.potential_trips = FieldValue.arrayRemove(otherPotential[etIndexInOtherPotential]);
                            otherTripUpdate.matched_trips = FieldValue.arrayUnion(matchedEntryForOther); // Add to matched_trips
                            editedTripUpdate.matched_trips[otherIndexInETMatched].mutual = true; // Set mutual to true in ET's matched entry   
                        }
                         transaction.update(tripRef, otherTripUpdate);
                         logger.info(`Updated radii for ET in paid matched trip ${tripRef.id}'s matched_trips.`);
                         finalMatchedTrips.push(tripElement as MatchedTrip); // Keep in matched list
                     } else {
                         const otherTripUpdate: Record<string, any> = {};
                         const otherMatched = [...(tripData.matched_trips || [])];
                         const otherPotential = [...(tripData.potential_trips || [])];
                         const etIndexInOther = findTripIndex(otherMatched, editedTripRef);
                         const otherIndexInETMatched = findTripIndex(editedTripUpdate.matched_trips, tripRef);
                         const etIndexInOtherPotential = findTripIndex(otherPotential, editedTripRef);
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
                             trip_obstruction: isTripObstructed || matchesGeometrically,
                             seat_obstruction: isSeatObstructed,
                             reserving_trip_obstruction: isReservingObstructed,
                             mutual: !matchesGeometrically || 
                             (!tripElement.mutual && isReservingObstructed && (isTripObstructed || isSeatObstructed)),
                             group_largest_pickup_overlap_gap: tgInfo?.largestPickupOverlapGap ?? null,
                             group_largest_destination_overlap_gap: tgInfo?.largestDestinationOverlapGap ?? null,
                             unknown_trip_obstruction: false, // Assuming known obstruction reasons
                             total_seat_count: tgInfo?.tripGroupData?.total_seat_count ?? null,
                             seat_count: tripData.seat_count // Add if needed
                         };
                         finalPotentialTrips.push(potentialEntry);
                         if (isSeatObstructed && isTripObstructed) {
                             customArrayUnion(editedTripUpdate.potential_trips, potentialEntry); // Use custom function to avoid duplicates
                             editedTripUpdate.matched_trips?.splice(otherIndexInETMatched, 1); // Remove from matched_trips
                         }

                         if (tripElement.mutual && matchesGeometrically) {
                            otherMatched[etIndexInOther].pickup_radius = editedTripData.pickup_radius;
                            otherMatched[etIndexInOther].destination_radius = editedTripData.destination_radius;
                            otherMatched[etIndexInOther].mutual = false; // Set mutual to false in other trip's matched entry
                            otherTripUpdate.matched_trips = otherMatched;
                         } else if (!tripElement.mutual && matchesGeometrically) {
                            if (isReservingObstructed) {
                                matched = (isTripObstructed || isSeatObstructed) ? false : true; // Set mutual to false if not obstructed
                                otherPotential[etIndexInOtherPotential].pickup_radius = editedTripData.pickup_radius;
                                otherPotential[etIndexInOtherPotential].destination_radius = editedTripData.destination_radius;
                                otherPotential[etIndexInOtherPotential].mutual = (isTripObstructed || isSeatObstructed) ? true : false; // Set mutual to false if not obstructed
                            } else {
                                const matchedEntryForOther: MatchedTrip = {
                                    trip_ref: editedTripRef,
                                    paid: false,
                                    trip_group_ref: null,
                                    pickup_radius: editedTripData.pickup_radius,
                                    destination_radius: editedTripData.destination_radius,
                                    pickup_distance: tripElement.pickup_distance, // Keep original distance
                                    destination_distance: tripElement.destination_distance, // Keep original distance
                                    mutual: false, // As requested
                                    reserving: false,
                                    seat_count: editedTripData.seat_count // Add if needed
                                 };
                                otherTripUpdate.potential_trips = FieldValue.arrayRemove(otherPotential[etIndexInOtherPotential]);
                                otherTripUpdate.matched_trips = FieldValue.arrayUnion(matchedEntryForOther); // Add to matched_trips
                            }
                        } else if (!tripElement.mutual && !matchesGeometrically) {
                            otherPotential[etIndexInOtherPotential].pickup_radius = editedTripData.pickup_radius;
                            otherPotential[etIndexInOtherPotential].destination_radius = editedTripData.destination_radius;
                            otherPotential[etIndexInOtherPotential].mutual = true;
                            otherPotential[etIndexInOtherPotential].reserving_trip_obstruction = isReservingObstructed ? true : false; // Set mutual to false if not obstructed
                            otherPotential[etIndexInOtherPotential].proper_match = false; // Set proper_match to false
                            otherTripUpdate.potential_trips = otherPotential;
                        } else if (tripElement.mutual && !matchesGeometrically) {
                            const potentialEntryForOther: PotentialTrip = {
                                trip_ref: editedTripRef,
                                paid: false,
                                trip_group_ref: null,
                                pickup_radius: editedTripData.pickup_radius,
                                destination_radius: editedTripData.destination_radius,
                                pickup_distance: tripElement.pickup_distance, // Keep original distance
                                destination_distance: tripElement.destination_distance, // Keep original distance
                                proper_match: false, // Matches geometrically
                                trip_obstruction: false,
                                seat_obstruction: false,
                                reserving_trip_obstruction: false,
                                mutual: true, // Set calculated mutual status
                                group_largest_pickup_overlap_gap: null,
                                group_largest_destination_overlap_gap: null,
                                unknown_trip_obstruction: false,
                                total_seat_count: null,
                                seat_count: editedTripData.seat_count // Add if needed
                            };
                            otherTripUpdate.matched_trips = FieldValue.arrayRemove(otherMatched[etIndexInOther]);
                            otherTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForOther); // Add to potential_trips
                        }
                         transaction.update(tripRef, otherTripUpdate);
                         logger.info(`Moved ET from matched to potential for paid trip ${tripRef.id}.`);
                     }
                    } else {
                        const otherMatched = [...(tripData.matched_trips || [])];
                        const otherPotential = [...(tripData.potential_trips || [])];
                        const otherTripUpdate: Record<string, any> = {};
                        const etIndexInOtherMatched = findTripIndex(otherMatched, editedTripRef);
                        const otherIndexInETMatched = findTripIndex(editedTripUpdate.matched_trips, tripRef);
                        const otherIndexInETPotential = findTripIndex(editedTripUpdate.potential_trips, tripRef);
                        const etIndexInOtherPotential = findTripIndex(otherPotential, editedTripRef);
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
                             mutual: true, // Preserve mutual
                             reserving: false, // ET not reserving here
                             seat_count: tripData.seat_count // Add if needed
                            };
                            customArrayUnion(editedTripUpdate.matched_trips, matchedEntry); // Use custom function to avoid duplicates
                            editedTripUpdate.potential_trips?.splice(otherIndexInETPotential, 1); // Remove from potential_trips
                            finalMatchedTrips.push(matchedEntry);
                            
                            if (tripElement.mutual) {
                                const matchedEntryForOther: MatchedTrip = {
                                    trip_ref: editedTripRef,
                                    paid: false,
                                    trip_group_ref: null,
                                    pickup_radius: editedTripData.pickup_radius,
                                    destination_radius: editedTripData.destination_radius,
                                    pickup_distance: tripElement.pickup_distance, // Keep original distance
                                    destination_distance: tripElement.destination_distance, // Keep original distance
                                    mutual: true, // As requested
                                    reserving: false,
                                    seat_count: editedTripData.seat_count // Add if needed
                                };
                                otherTripUpdate.potential_trips = FieldValue.arrayRemove(otherPotential[etIndexInOtherPotential]);
                                otherTripUpdate.matched_trips = FieldValue.arrayUnion(matchedEntryForOther); // Add to matched_trips
                            } else {
                                if (etIndexInOtherMatched !== -1) {
                                    otherMatched[etIndexInOtherMatched].pickup_radius = editedTripData.pickup_radius;
                                    otherMatched[etIndexInOtherMatched].destination_radius = editedTripData.destination_radius;
                                    otherMatched[etIndexInOtherMatched].mutual = true; // Set mutual to false in other trip's matched entry
                                    otherTripUpdate.matched_trips = otherMatched;
                                } else {
                                    logger.warn(`ET not found in paid matched trip ${tripRef.id}'s matched_trips for update.`);
                                }
                            }
                         transaction.update(tripRef, otherTripUpdate);
                         logger.info(`Moved ET from potential to matched for paid trip ${tripRef.id}.`);
                     } else {
                         // n188 -> No OR n198 -> Yes: Stays Potential, update details
                         logger.info(`Paid potential trip ${tripRef.id} remains potential (or cannot be matched). Updating details.`);
                         
                         if (isTripObstructed && isSeatObstructed) {
                             editedTripUpdate.potential_trips[otherIndexInETPotential].proper_match = matchesGeometrically; // Update proper_match
                             editedTripUpdate.potential_trips[otherIndexInETPotential].trip_obstruction = isTripObstructed; // Update trip_obstruction
                             editedTripUpdate.potential_trips[otherIndexInETPotential].seat_obstruction = isSeatObstructed; // Update seat_obstruction
                             editedTripUpdate.potential_trips[otherIndexInETPotential].mutual = !matchesGeometrically || (tripElement.mutual && isReservingObstructed);; // Update reserving_trip_obstruction
                             editedTripUpdate.potential_trips[otherIndexInETPotential].group_largest_destination_overlap_gap = tgInfo?.largestDestinationOverlapGap ?? null; // Update largest gap
                             editedTripUpdate.potential_trips[otherIndexInETPotential].group_largest_pickup_overlap_gap = tgInfo?.largestPickupOverlapGap ?? null; // Update largest gap
                         }

                         if (matchesGeometrically && tripElement.mutual) {
                            if (isReservingObstructed) {
                                if (!isTripObstructed && !isSeatObstructed) {
                                    matched = true;
                                    const matchedEntry: MatchedTrip = {
                                        trip_ref: tripRef,
                                        paid: true,
                                        trip_group_ref: tgRef,
                                        pickup_radius: tripData.pickup_radius,
                                        destination_radius: tripData.destination_radius,
                                        pickup_distance: tripElement.pickup_distance,
                                        destination_distance: tripElement.destination_distance,
                                        mutual: false, // Preserve mutual
                                        reserving: false, // ET not reserving here
                                        seat_count: tripData.seat_count // Add if needed
                                       };
                                       customArrayUnion(editedTripUpdate.matched_trips, matchedEntry); // Use custom function to avoid duplicates
                                       editedTripUpdate.potential_trips?.splice(otherIndexInETPotential, 1); // Remove from potential_trips           
                                    otherPotential[etIndexInOtherPotential].pickup_radius = editedTripData.pickup_radius;
                                    otherPotential[etIndexInOtherPotential].destination_radius = editedTripData.destination_radius;
                                    otherPotential[etIndexInOtherPotential].mutual = false; // Set mutual to false if not obstructed
                                } else {
                                    otherPotential[etIndexInOtherPotential].pickup_radius = editedTripData.pickup_radius;
                                    otherPotential[etIndexInOtherPotential].destination_radius = editedTripData.destination_radius;
                                    editedTripUpdate.potential_trips[otherIndexInETPotential].trip_obstruction = tgInfo?.tripObstruction ?? false; // Set trip obstruction to true
                                    editedTripUpdate.potential_trips[otherIndexInETPotential].proper_match = true; // Set proper_match to true
                                }
                            } else {
                                const matchedEntryForOther: MatchedTrip = {
                                    trip_ref: editedTripRef,
                                    paid: false,
                                    trip_group_ref: null,
                                    pickup_radius: editedTripData.pickup_radius,
                                    destination_radius: editedTripData.destination_radius,
                                    pickup_distance: tripElement.pickup_distance, // Keep original distance
                                    destination_distance: tripElement.destination_distance, // Keep original distance
                                    mutual: false, // As requested
                                    reserving: false,
                                    seat_count: editedTripData.seat_count // Add if needed
                                 };
                                otherTripUpdate.potential_trips = FieldValue.arrayRemove(otherPotential[etIndexInOtherPotential]);
                                otherTripUpdate.matched_trips = FieldValue.arrayUnion(matchedEntryForOther); // Add to matched_trips
                            }
                        } else if (matchesGeometrically && !tripElement.mutual) {
                            otherMatched[etIndexInOtherMatched].pickup_radius = editedTripData.pickup_radius;
                            otherMatched[etIndexInOtherMatched].destination_radius = editedTripData.destination_radius;
                            otherTripUpdate.matched_trips = otherMatched;
                        } else if (!matchesGeometrically && tripElement.mutual) {
                            otherPotential[etIndexInOtherPotential].pickup_radius = editedTripData.pickup_radius;
                            otherPotential[etIndexInOtherPotential].destination_radius = editedTripData.destination_radius;
                            otherPotential[etIndexInOtherPotential].reserving_trip_obstruction = isReservingObstructed ? true : false; // Set mutual to false if not obstructed
                            otherPotential[etIndexInOtherPotential].proper_match = false; // Set proper_match to false
                            otherTripUpdate.potential_trips = otherPotential;
                        } else if (!matchesGeometrically && !tripElement.mutual) {
                            const potentialEntryForOther: PotentialTrip = {
                                trip_ref: editedTripRef,
                                paid: false,
                                trip_group_ref: null,
                                pickup_radius: editedTripData.pickup_radius,
                                destination_radius: editedTripData.destination_radius,
                                pickup_distance: tripElement.pickup_distance, // Keep original distance
                                destination_distance: tripElement.destination_distance, // Keep original distance
                                proper_match: false, // Matches geometrically
                                trip_obstruction: false,
                                seat_obstruction: false,
                                reserving_trip_obstruction: false,
                                mutual: true, // Set calculated mutual status
                                group_largest_pickup_overlap_gap: null,
                                group_largest_destination_overlap_gap: null,
                                unknown_trip_obstruction: false,
                                total_seat_count: null,
                                seat_count: editedTripData.seat_count // Add if needed
                            };
                            otherTripUpdate.matched_trips = FieldValue.arrayRemove(otherMatched[etIndexInOtherMatched]);
                            otherTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForOther); // Add to potential_trips
                        }
                     }
                 }
            } // End loop through paid trips

            // n222: Final Status Check
            const currentStatus = editedTripData.status;
            const hasMatchesNow = editedTripUpdate.matched_trips.length > 0;

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
                     editedTripUpdate.reserving_trip_ref = FieldValue.delete() as any;
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