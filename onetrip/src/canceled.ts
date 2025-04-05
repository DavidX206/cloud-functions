import * as logger from "firebase-functions/logger";
import {
  onDocumentUpdated
} from "firebase-functions/v2/firestore";
import {
  getFirestore,
  Timestamp,
  FieldValue,
  DocumentReference,
  GeoPoint as FirestoreGeoPoint, // Use alias to avoid conflict if LatLng defined locally
} from "firebase-admin/firestore";
import {Trip, MatchedTrip, PotentialTrip, TripGroup, TripGroupMember, ObstructingTripMember, RecentMessage, Message, LatLng} from "../../type"
import {
  initializeApp
} from "firebase-admin/app";
// Assume initialization if not already done
try {
  initializeApp();
} catch (e) {
  logger.info("Firebase app already initialized.");
}
import {
  HttpsError
} from "firebase-functions/v2/https";

// -
import { properMatchGeometric, updateNestedTripField } from './utils/utils';

// Helper function to check if LatLng objects are equal
function areLatLngEqual(ll1: LatLng | FirestoreGeoPoint | undefined, ll2: LatLng | FirestoreGeoPoint | undefined): boolean {
  if (!ll1 || !ll2) return false;
  // Handle both potential types
  const lat1 = 'latitude' in ll1 ? ll1.latitude : ll1.lat;
  const lng1 = 'longitude' in ll1 ? ll1.longitude : ll1.lng;
  const lat2 = 'latitude' in ll2 ? ll2.latitude : ll2.lat;
  const lng2 = 'longitude' in ll2 ? ll2.longitude : ll2.lng;
  return lat1 === lat2 && lng1 === lng2;
}

// Placeholder for distance calculation if not imported
function distanceBetween(coord1: LatLng | FirestoreGeoPoint, coord2: LatLng | FirestoreGeoPoint): number {
  // Replace with actual Haversine distance calculation
  logger.warn("Placeholder distanceBetween function used.");
  const lat1 = 'latitude' in coord1 ? coord1.latitude : coord1.lat;
  const lon1 = 'longitude' in coord1 ? coord1.longitude : coord1.lng;
  const lat2 = 'latitude' in coord2 ? coord2.latitude : coord2.lat;
  const lon2 = 'longitude' in coord2 ? coord2.longitude : coord2.lng;

  const R = 6371e3; // metres
  const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in metres
}

// Helper to format time range array (Node n102) - simplified
function formatTimeRangeArray(isoStrings: string[]): string[] {
    if (!isoStrings || isoStrings.length === 0) return [];

    const referenceDate = new Date(isoStrings[0]).toDateString();
    const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    return isoStrings.map(iso => {
        const date = new Date(iso);
        const formattedTime = timeFormat.format(date);
        if (date.toDateString() !== referenceDate) {
            return `${formattedTime} (Next Day)`;
        }
        return formattedTime;
    });
}

// Helper to get array union (used for time range check)
function arrayUnion<T>(...arrays: T[][]): T[] {
  const set = new Set<T>();
  for (const arr of arrays) {
    if (arr) {
       arr.forEach(item => set.add(item));
    }
  }
  return Array.from(set).sort(); // Sorting ensures consistent order for comparison
}


// --- Cloud Function Definition ---
export const tripCanceled = onDocumentUpdated("users/{userId}/trips/{tripId}", async (event) => {
  logger.info(`tripCanceled triggered for users/${event.params.userId}/trips/${event.params.tripId}`);

  const beforeSnap = event.data ?.before;
  const afterSnap = event.data ?.after;

  if (!beforeSnap ?.exists || !afterSnap ?.exists) {
    logger.warn("Document snapshot missing before or after update.");
    return;
  }

  const beforeData = beforeSnap.data() as Trip | undefined;
  const canceledTrip = afterSnap.data() as Trip | undefined;
  const canceledTripRef = afterSnap.ref;
  const canceledTripId = event.params.tripId;
  const userId = event.params.userId;
  const userRef = getFirestore().collection('users').doc(userId);


  if (!canceledTrip || !beforeData) {
    logger.error("Failed to get trip data.");
    return;
  }

  // --- Check if the trigger condition is met (status changed to 'canceled') ---
  if (beforeData.status === 'canceled' || canceledTrip.status !== 'canceled') {
    logger.info(`Trip status did not change to 'canceled'. Before: ${beforeData.status}, After: ${canceledTrip.status}. Exiting.`);
    return;
  }

  logger.info(`Processing cancellation for trip ${canceledTripId}`);

  const db = getFirestore();
  const batch = db.batch(); // Use batch for independent updates where possible
  let transactionPromises: Promise < any > [] = []; // For transaction-dependent updates

  // --- n2: Does canceled trip have matched_trips? ---
  const matchedTrips = canceledTrip.matched_trips || [];
  const potentialTrips = canceledTrip.potential_trips || [];

  // --- n3: Does canceled trip have matched_trips that it is reserving? ---
  const reservedByCanceledTripIndex = matchedTrips.findIndex(mt => mt.reserving === true);
  let formerlyReservedTripRef: DocumentReference | null = null;
  let formerlyReservedTripData: Trip | null = null;

  if (reservedByCanceledTripIndex !== -1) {
    formerlyReservedTripRef = matchedTrips[reservedByCanceledTripIndex].trip_ref;
    logger.info(`Canceled trip ${canceledTripId} was reserving trip ${formerlyReservedTripRef.id}.`);

    // --- n4-n9: Logic for the trip that the canceled trip was reserving ---
    const formerlyReservedTripTransactionPromise = db.runTransaction(async (transaction) => {
      const formerlyReservedTripSnap = await transaction.get(formerlyReservedTripRef !);
      if (!formerlyReservedTripSnap.exists) {
        logger.warn(`Formerly reserved trip ${formerlyReservedTripRef!.id} not found.`);
        return null; // Indicate failure or skip
      }
      formerlyReservedTripData = formerlyReservedTripSnap.data() as Trip;

      // n4: Update reserved trip
      transaction.update(formerlyReservedTripRef !, {
        reserved: false,
        reserving_trip_ref: FieldValue.delete(),
      });
      logger.info(`Updated formerly reserved trip ${formerlyReservedTripRef!.id}: reserved=false, deleted reserving_trip_ref.`);

      // n5: Get related trips of the formerly reserved trip
      // "matched trips with mutual as true and potential trips with mutual as false" - Interpreting as trips that *see* the formerly reserved trip as matched/potential
      // This requires fetching *all* trips potentially, which is inefficient. A better approach would be querying trips that have formerlyReservedTripRef in their arrays.
      // Simplified Approach: Fetch trips directly mentioned in formerlyReservedTripData's arrays.
      const relatedMatchedRefs = (formerlyReservedTripData.matched_trips || [])
        .filter(mt => mt.mutual) // As per n5: mutual=true
        .map(mt => mt.trip_ref);
      const relatedPotentialRefs = (formerlyReservedTripData.potential_trips || [])
        .filter(pt => !pt.mutual) // As per n5: mutual=false
        .map(pt => pt.trip_ref);

      const allRelatedRefs = [...relatedMatchedRefs, ...relatedPotentialRefs];
      if (allRelatedRefs.length === 0) {
        logger.info(`Formerly reserved trip ${formerlyReservedTripRef!.id} has no relevant related trips (matched mutual=T, potential mutual=F).`);
        return formerlyReservedTripData; // Return data for later use if needed
      }

      const relatedTripSnaps = await transaction.getAll(...allRelatedRefs);

      // n6, n7, n8: Update these related trips
      const formerlyReservedTripId = formerlyReservedTripRef!.id;
      const updatesForRelatedTrips: {
        ref: DocumentReference,
        update: Record < string, any >
      } [] = [];
      const tripsToAddToMatched: DocumentReference[] = [];
      const tripsToRemoveFromPotential: DocumentReference[] = [];

      relatedTripSnaps.forEach(snap => {
        if (!snap.exists) {
          logger.warn(`Related trip ${snap.id} not found during transaction.`);
          return;
        }
        const relatedTrip = snap.data() as Trip;
        const relatedTripUpdate: Record < string, any > = {};
        let changed = false;

        const potentialIndex = (relatedTrip.potential_trips || []).findIndex(pt => pt.trip_ref.id === formerlyReservedTripId);

        if (potentialIndex !== -1 && relatedTrip.potential_trips[potentialIndex].reserving_trip_obstruction) {
          const potentialEntry = relatedTrip.potential_trips[potentialIndex];
          logger.info(`Processing related trip ${snap.id}, found formerly reserved trip ${formerlyReservedTripId} in potential_trips at index ${potentialIndex} with reserving_trip_obstruction=true.`);

          if (!potentialEntry.proper_match) { // n7
            logger.info(`Related trip ${snap.id}: formerly reserved trip ${formerlyReservedTripId} had proper_match=false. Setting reserving_trip_obstruction=false.`);
            updateNestedTripField(relatedTripUpdate, 'potential_trips', potentialIndex, 'reserving_trip_obstruction', false);
            changed = true;
          } else { // n8: proper_match is true
            logger.info(`Related trip ${snap.id}: formerly reserved trip ${formerlyReservedTripId} had proper_match=true. Moving from potential to matched.`);
            // Remove from potential_trips
            relatedTripUpdate['potential_trips'] = FieldValue.arrayRemove(potentialEntry);

            // Determine mutual status for the new matched entry
            // "If this trip was in the trip that canceled trip was reserving’s matched trip array, then true, else false"
            const wasInFormerlyReservedMatched = (formerlyReservedTripData ?.matched_trips || []).some(mt => mt.trip_ref.id === snap.id);

            // Add to matched_trips
            const newMatchedEntry: MatchedTrip = {
              trip_ref: formerlyReservedTripRef !,
              trip_group_ref: null, // n8: trip_group_id: N/A
              paid: false, // n8: paid: false
              pickup_radius: formerlyReservedTripData ?.pickup_radius ?? 0, // n8: relevant value
              destination_radius: formerlyReservedTripData ?.destination_radius ?? 0, // n8: relevant value
              pickup_distance: potentialEntry.pickup_distance, // n8: relevant value (use existing)
              destination_distance: potentialEntry.destination_distance, // n8: relevant value (use existing)
              mutual: wasInFormerlyReservedMatched, // n8: conditional mutual
              reserving: false, // n8: reserving: false
              seat_count: formerlyReservedTripData ?.seat_count ?? 0, // Added seat_count based on schema
            };
            relatedTripUpdate['matched_trips'] = FieldValue.arrayUnion(newMatchedEntry);
            tripsToAddToMatched.push(snap.ref); // Track for n9 update
            changed = true;
          }
        } else {
             logger.info(`Related trip ${snap.id}: formerly reserved trip ${formerlyReservedTripId} not found in potential_trips or reserving_trip_obstruction was false.`);
        }

        if (changed) {
          updatesForRelatedTrips.push({
            ref: snap.ref,
            update: relatedTripUpdate
          });
        }
      });

      // Apply updates for related trips (n7, n8)
      updatesForRelatedTrips.forEach(upd => {
        transaction.update(upd.ref, upd.update);
        logger.info(`Updating related trip ${upd.ref.id} with changes:`, upd.update);
      });


      // n9: Update the formerly reserved trip's arrays
      const formerlyReservedUpdate: Record < string, any > = {};
      let formerlyReservedChanged = false;

      // "In it’s matched trips array, update all the elements containing it’s matched trips with mutual as false that proper match it: mutual: true"
      (formerlyReservedTripData ?.matched_trips || []).forEach((mt, index) => {
        if (!mt.mutual) {
          // Check if this matched trip 'mt' is one of the related trips that now proper matches (i.e., moved to matched in step n8)
          const wasMovedToMatched = tripsToAddToMatched.some(ref => ref.id === mt.trip_ref.id);
          if (wasMovedToMatched) {
             logger.info(`Updating formerly reserved trip ${formerlyReservedTripRef!.id}: setting matched_trips[${index}] (trip ${mt.trip_ref.id}) mutual=true`);
            updateNestedTripField(formerlyReservedUpdate, 'matched_trips', index, 'mutual', true);
            formerlyReservedChanged = true;
          }
        }
      });

      // "In it’s potential trips array, update all the elements containing it’s potential trips with mutual as true that proper match it: mutual: false"
      (formerlyReservedTripData ?.potential_trips || []).forEach((pt, index) => {
        if (pt.mutual && pt.proper_match) {
          // Check if this potential trip 'pt' corresponds to one updated in n7 or n8.
          // Those updated in n8 were removed from potential, so we only care about n7 (reserving_trip_obstruction set to false).
          const wasUpdatedInN7 = updatesForRelatedTrips.some(upd =>
            upd.ref.id === pt.trip_ref.id &&
            upd.update[`potential_trips.${potentialIndex}.reserving_trip_obstruction`] === false // Check if it was the n7 update
          );
           // Check if this potential trip 'pt' was one of the related trips that now proper matches (added to matched in n8). If so, it shouldn't be in potential anymore.
           const wasMovedToMatched = tripsToAddToMatched.some(ref => ref.id === pt.trip_ref.id);

          if (wasUpdatedInN7 || !wasMovedToMatched) { // If it was updated in n7 OR if it wasn't moved in n8 but meets condition
             logger.info(`Updating formerly reserved trip ${formerlyReservedTripRef!.id}: setting potential_trips[${index}] (trip ${pt.trip_ref.id}) mutual=false`);
             updateNestedTripField(formerlyReservedUpdate, 'potential_trips', index, 'mutual', false);
             formerlyReservedChanged = true;
          } else if (wasMovedToMatched) {
             logger.info(`Formerly reserved trip ${formerlyReservedTripRef!.id}: Potential trip ${pt.trip_ref.id} was moved to matched, removing from potential.`);
             // It was moved in n8, ensure it's removed from potential array
             formerlyReservedUpdate['potential_trips'] = FieldValue.arrayRemove(pt);
             formerlyReservedChanged = true;
          }
        }
      });


      if (formerlyReservedChanged) {
        transaction.update(formerlyReservedTripRef !, formerlyReservedUpdate);
         logger.info(`Updating formerly reserved trip ${formerlyReservedTripRef!.id} mutual flags:`, formerlyReservedUpdate);
      }

      return formerlyReservedTripData; // Return data for potential use in reservation logic
    });
    transactionPromises.push(formerlyReservedTripTransactionPromise);
    await formerlyReservedTripTransactionPromise; // Ensure this completes before potentially re-reserving below
  }


  // --- n10-n14: Clean up canceled trip from its Matched Trips ---
  const matchedTripUpdates: {
    ref: DocumentReference,
    update: Record < string, any >
  } [] = [];
  matchedTrips.forEach((mt) => {
    const update: Record < string, any > = {};
    const elementToRemove = { // Construct object matching the one to remove
      trip_ref: canceledTripRef,
      // Include other fields that might be necessary for FieldValue.arrayRemove to match
      // This depends on how exactly elements are added/structured. Assuming trip_ref is sufficient.
      // Let's fetch the other trip and check its arrays for a more robust removal.
    };

    if (mt.mutual) { // n13: If mutual, remove from their matched_trips
      update['matched_trips'] = FieldValue.arrayRemove(elementToRemove); // Simplistic, relies on matching structure
      logger.info(`Preparing update for matched trip ${mt.trip_ref.id}: remove canceled trip ${canceledTripId} from matched_trips.`);
    } else { // n12: If not mutual, remove from their potential_trips
      update['potential_trips'] = FieldValue.arrayRemove(elementToRemove); // Simplistic
      logger.info(`Preparing update for matched trip ${mt.trip_ref.id}: remove canceled trip ${canceledTripId} from potential_trips.`);
    }
    matchedTripUpdates.push({
      ref: mt.trip_ref,
      update
    });
  });


  // --- n15-n20: Clean up canceled trip from its Potential Trips ---
  const potentialTripUpdates: {
    ref: DocumentReference,
    update: Record < string, any >
  } [] = [];
  potentialTrips.forEach((pt) => {
    const update: Record < string, any > = {};
     const elementToRemove = { trip_ref: canceledTripRef /* ... other fields if needed */ };

    if (pt.mutual) { // n20: If mutual, remove from their potential_trips
      update['potential_trips'] = FieldValue.arrayRemove(elementToRemove);
      logger.info(`Preparing update for potential trip ${pt.trip_ref.id}: remove canceled trip ${canceledTripId} from potential_trips.`);
    } else { // n18: If not mutual, remove from their matched_trips (GraphML logic)
      update['matched_trips'] = FieldValue.arrayRemove(elementToRemove);
       logger.info(`Preparing update for potential trip ${pt.trip_ref.id}: remove canceled trip ${canceledTripId} from matched_trips.`);
    }
    potentialTripUpdates.push({
      ref: pt.trip_ref,
      update
    });
  });

  // Apply batch updates for matched/potential cleanup
  matchedTripUpdates.forEach(upd => batch.update(upd.ref, upd.update));
  potentialTripUpdates.forEach(upd => batch.update(upd.ref, upd.update));

  // --- n21: Is cancelled Trip reserved? ---
  let formerReservingTripRef: DocumentReference | null = null;
  let formerReservingTripData: Trip | null = null;
  let wasPaidAndReserved = false; // Track if the reserving trip was paid

  if (canceledTrip.reserved && canceledTrip.reserving_trip_ref) {
    formerReservingTripRef = canceledTrip.reserving_trip_ref;
    logger.info(`Canceled trip ${canceledTripId} was reserved by ${formerReservingTripRef.id}.`);

    // Need data from the former reserving trip
    const formerReservingTripSnap = await formerReservingTripRef.get();
    if (!formerReservingTripSnap.exists) {
      logger.error(`Former reserving trip ${formerReservingTripRef.id} not found! Cannot proceed with reservation logic.`);
    } else {
      formerReservingTripData = formerReservingTripSnap.data() as Trip;
       wasPaidAndReserved = !!formerReservingTripData.trip_group_ref; // Check if it was paid/in a group

      // --- n22-n35: Logic for the former reserving trip finding a new trip to reserve ---
      // This needs to happen within a transaction to read the state and update consistently.
      const newReservationTransactionPromise = db.runTransaction(async (transaction) => {
        // Re-fetch former reserving trip within transaction
        const reservingTripSnap = await transaction.get(formerReservingTripRef !);
        if (!reservingTripSnap.exists) {
          logger.warn(`Former reserving trip ${formerReservingTripRef!.id} disappeared during transaction.`);
          return;
        }
        const reservingTrip = reservingTripSnap.data() as Trip;
        let newlyReservedTripRef: DocumentReference | null = null;
        let newlyReservedTripData: Trip | null = null;
        let newlyReservedTripIndexInFormerReserving = -1;

        // n23: Find nearest matched trip
        const candidateTrips = (reservingTrip.matched_trips || [])
            .filter(mt => mt.trip_ref.id !== canceledTripId); // Exclude the canceled trip

        if (candidateTrips.length > 0) {
          let minDistance = Infinity;
          let bestCandidatesIndices: number[] = [];

          candidateTrips.forEach((mt, index) => {
             // Find the original index in the reservingTrip.matched_trips array
             const originalIndex = (reservingTrip.matched_trips || []).findIndex(origMt => origMt.trip_ref.id === mt.trip_ref.id);
             if (originalIndex === -1) return; // Should not happen

            const combinedDistance = mt.pickup_distance + mt.destination_distance;
            if (combinedDistance < minDistance) {
              minDistance = combinedDistance;
              bestCandidatesIndices = [originalIndex];
            } else if (combinedDistance === minDistance) {
              bestCandidatesIndices.push(originalIndex);
            }
          });

          // n24, n25: Handle ties
          const chosenIndex = bestCandidatesIndices.length === 1 ?
            bestCandidatesIndices[0] :
            bestCandidatesIndices[Math.floor(Math.random() * bestCandidatesIndices.length)];

          newlyReservedTripIndexInFormerReserving = chosenIndex;
          newlyReservedTripRef = reservingTrip.matched_trips[chosenIndex].trip_ref;
          logger.info(`Former reserving trip ${formerReservingTripRef!.id} will now reserve trip ${newlyReservedTripRef.id} (index ${chosenIndex}).`);


          // n26: Update newly reserved trip
          const newlyReservedSnap = await transaction.get(newlyReservedTripRef);
          if (!newlyReservedSnap.exists) {
             logger.warn(`Newly reserved trip ${newlyReservedTripRef.id} not found during transaction.`);
             newlyReservedTripRef = null; // Cannot proceed with this trip
          } else {
             newlyReservedTripData = newlyReservedSnap.data() as Trip;
             transaction.update(newlyReservedTripRef, {
                 reserved: true,
                 reserving_trip_ref: formerReservingTripRef // n26 uses 'id', schema says ref
             });
             logger.info(`Updated newly reserved trip ${newlyReservedTripRef.id}: reserved=true, reserving_trip_ref=${formerReservingTripRef!.id}`);

             // n28: Update former reserving trip's matched_trips array
             const formerReservingUpdate: Record<string, any> = {};
             updateNestedTripField(formerReservingUpdate, 'matched_trips', newlyReservedTripIndexInFormerReserving, 'reserving', true);
             transaction.update(formerReservingTripRef!, formerReservingUpdate);
             logger.info(`Updated former reserving trip ${formerReservingTripRef!.id}: set matched_trips[${newlyReservedTripIndexInFormerReserving}].reserving=true`);


            // n29-n35: Complex propagation logic for the *new* reservation
            if (newlyReservedTripRef && newlyReservedTripData) {
               const finalNewlyReservedTripRef = newlyReservedTripRef; // Capture for use in loops

              // n29: Find trips related to newly reserved trip that DON'T proper match former reserving trip
              // "matched trips with mutual as true and potential trips with mutual and false" of newly reserved trip
              const relatedToNewMatchedRefs = (newlyReservedTripData.matched_trips || [])
                .filter(mt => mt.mutual && mt.trip_ref.id !== formerReservingTripRef!.id)
                .map(mt => mt.trip_ref);
              const relatedToNewPotentialRefs = (newlyReservedTripData.potential_trips || [])
                 .filter(pt => !pt.mutual && pt.trip_ref.id !== formerReservingTripRef!.id)
                 .map(pt => pt.trip_ref);
              const allRelatedToNewRefs = [...relatedToNewMatchedRefs, ...relatedToNewPotentialRefs];

              if (allRelatedToNewRefs.length > 0) {
                  const relatedToNewSnaps = await transaction.getAll(...allRelatedToNewRefs);
                  const updatesForAffectedNeighbors: { ref: DocumentReference, update: Record<string, any>, originalMutual?: boolean, hadOnlyNewReserved?: boolean }[] = [];
                  const tripsToUpdateMutualOnNew: { ref: DocumentReference, newMutual: boolean }[] = [];


                 relatedToNewSnaps.forEach(snap => {
                     if (!snap.exists) { logger.warn(`Related trip ${snap.id} for newly reserved not found.`); return; }
                     const neighborTrip = snap.data() as Trip;

                    // Check if neighborTrip proper matches formerReservingTrip (geometric check needed here)
                    // Need formerReservingTrip data again (fetched as reservingTrip earlier in transaction)
                    const doesProperMatchFormerReserving = properMatchGeometric(neighborTrip, reservingTrip); // Assuming helper exists

                    if (!doesProperMatchFormerReserving) {
                        logger.info(`Neighbor trip ${snap.id} does not proper match former reserving trip ${reservingTripSnap.id}. Processing n30.`);
                       // n30: Update these neighbors
                       const neighborUpdate: Record<string, any> = {};
                       let neighborChanged = false;
                       let originalMutualInMatched: boolean | undefined = undefined;
                       let hadOnlyNewReservedMatch = false;

                       // Find newly reserved trip in neighbor's matched_trips
                       const matchedIndex = (neighborTrip.matched_trips || []).findIndex(mt => mt.trip_ref.id === finalNewlyReservedTripRef.id);
                       if (matchedIndex !== -1) {
                            const matchedEntry = neighborTrip.matched_trips[matchedIndex];
                            originalMutualInMatched = matchedEntry.mutual; // Store original mutual for potential array

                            // Remove from matched_trips
                           neighborUpdate['matched_trips'] = FieldValue.arrayRemove(matchedEntry);
                            logger.info(`Neighbor ${snap.id}: Removing newly reserved trip ${finalNewlyReservedTripRef.id} from matched_trips.`);

                            // Add to potential_trips
                            const newPotentialEntry: PotentialTrip = {
                                trip_ref: finalNewlyReservedTripRef,
                                paid: false, // n30
                                trip_group_ref: null, // n30
                                pickup_radius: newlyReservedTripData?.pickup_radius ?? 0, // n30 relevant
                                destination_radius: newlyReservedTripData?.destination_radius ?? 0, // n30 relevant
                                pickup_distance: matchedEntry.pickup_distance, // Use existing distance
                                destination_distance: matchedEntry.destination_distance, // Use existing distance
                                proper_match: true, // n30 - assuming it was a proper match before being obstructed
                                trip_obstruction: false, // n30
                                seat_obstruction: false, // n30
                                reserving_trip_obstruction: true, // n30 - KEY UPDATE
                                mutual: !originalMutualInMatched, // n30 - opposite of deleted matched mutual
                                group_largest_pickup_overlap_gap: null, // n30 N/A
                                group_largest_destination_overlap_gap: null, // n30 N/A
                                unknown_trip_obstruction: false, // n30
                                total_seat_count: null, // n30 N/A
                                seat_count: newlyReservedTripData?.seat_count ?? 0, // Schema requires
                            };
                           neighborUpdate['potential_trips'] = FieldValue.arrayUnion(newPotentialEntry);
                           logger.info(`Neighbor ${snap.id}: Adding newly reserved trip ${finalNewlyReservedTripRef.id} to potential_trips with reserving_trip_obstruction=true.`);

                           // Track for n31 update
                           tripsToUpdateMutualOnNew.push({ ref: snap.ref, newMutual: !originalMutualInMatched });

                           // n32: Check if this was the *only* matched trip
                           hadOnlyNewReservedMatch = (neighborTrip.matched_trips || []).length === 1;

                           neighborChanged = true;
                       } else {
                           logger.warn(`Neighbor ${snap.id}: Expected newly reserved trip ${finalNewlyReservedTripRef.id} in matched_trips, but not found.`);
                       }

                       if(neighborChanged) {
                           updatesForAffectedNeighbors.push({ ref: snap.ref, update: neighborUpdate, originalMutual: originalMutualInMatched, hadOnlyNewReserved: hadOnlyNewReservedMatch });
                       }
                    } else {
                         logger.info(`Neighbor trip ${snap.id} DOES proper match former reserving trip ${reservingTripSnap.id}. Skipping n30.`);
                    }
                 });

                  // Apply updates for neighbors (n30)
                  updatesForAffectedNeighbors.forEach(upd => {
                      transaction.update(upd.ref, upd.update);
                      logger.info(`Updating neighbor ${upd.ref.id} due to new reservation obstruction:`, upd.update);
                  });

                  // n31: Update newly reserved trip's arrays based on neighbors processed in n30
                  const newlyReservedUpdate: Record<string, any> = {};
                  let newlyReservedChanged = false;
                  tripsToUpdateMutualOnNew.forEach(neighborInfo => {
                      // Find neighbor in newly reserved trip's matched or potential array and update mutual
                     const matchedIdx = (newlyReservedTripData?.matched_trips || []).findIndex(mt => mt.trip_ref.id === neighborInfo.ref.id);
                     const potentialIdx = (newlyReservedTripData?.potential_trips || []).findIndex(pt => pt.trip_ref.id === neighborInfo.ref.id);

                      if (matchedIdx !== -1) {
                         logger.info(`Updating newly reserved trip ${finalNewlyReservedTripRef.id}: setting matched_trips[${matchedIdx}] (neighbor ${neighborInfo.ref.id}) mutual=${neighborInfo.newMutual}`);
                         updateNestedTripField(newlyReservedUpdate, 'matched_trips', matchedIdx, 'mutual', neighborInfo.newMutual);
                         newlyReservedChanged = true;
                     } else if (potentialIdx !== -1) {
                         logger.info(`Updating newly reserved trip ${finalNewlyReservedTripRef.id}: setting potential_trips[${potentialIdx}] (neighbor ${neighborInfo.ref.id}) mutual=${neighborInfo.newMutual}`);
                         updateNestedTripField(newlyReservedUpdate, 'potential_trips', potentialIdx, 'mutual', neighborInfo.newMutual);
                         newlyReservedChanged = true;
                     } else {
                         logger.warn(`Could not find neighbor ${neighborInfo.ref.id} in newly reserved trip ${finalNewlyReservedTripRef.id}'s arrays for mutual update (n31).`);
                     }
                  });
                  if (newlyReservedChanged) {
                      transaction.update(finalNewlyReservedTripRef, newlyReservedUpdate);
                     logger.info(`Updating newly reserved trip ${finalNewlyReservedTripRef.id} mutual flags based on n30:`, newlyReservedUpdate);
                  }

                  // n32, n33: Update status for neighbors that lost their only match
                  updatesForAffectedNeighbors.forEach(upd => {
                     if (upd.hadOnlyNewReserved) {
                        logger.info(`Neighbor ${upd.ref.id} lost its only match. Setting status to 'unmatched'.`);
                        transaction.update(upd.ref, { status: 'unmatched' });
                     }
                 });


                // n34: Find other related trips ("matched mutual=F, potential mutual=T") that DON'T proper match former reserving trip
                 const otherRelatedToNewMatchedRefs = (newlyReservedTripData.matched_trips || [])
                     .filter(mt => !mt.mutual && mt.trip_ref.id !== formerReservingTripRef!.id)
                     .map(mt => mt.trip_ref);
                 const otherRelatedToNewPotentialRefs = (newlyReservedTripData.potential_trips || [])
                     .filter(pt => pt.mutual && pt.trip_ref.id !== formerReservingTripRef!.id)
                     .map(pt => pt.trip_ref);
                 const otherAllRelatedToNewRefs = [...otherRelatedToNewMatchedRefs, ...otherRelatedToNewPotentialRefs];

                 if (otherAllRelatedToNewRefs.length > 0) {
                     const otherRelatedToNewSnaps = await transaction.getAll(...otherAllRelatedToNewRefs);
                     otherRelatedToNewSnaps.forEach(snap => {
                         if (!snap.exists) { logger.warn(`Other related trip ${snap.id} for newly reserved not found.`); return; }
                         const neighborTrip = snap.data() as Trip;
                         const doesProperMatchFormerReserving = properMatchGeometric(neighborTrip, reservingTrip);

                         if (!doesProperMatchFormerReserving) {
                             logger.info(`Other neighbor trip ${snap.id} does not proper match former reserving trip ${reservingTripSnap.id}. Processing n35.`);
                            // n35: Update their matched trips array (GraphML says matched_trips, seems potentially wrong, should be potential?)
                            // Update the element representing the newly reserved trip.
                             const potentialIndex = (neighborTrip.potential_trips || []).findIndex(pt => pt.trip_ref.id === finalNewlyReservedTripRef.id);
                             if (potentialIndex !== -1) {
                                 const neighborUpdate: Record<string, any> = {};
                                 logger.info(`Other neighbor ${snap.id}: Setting potential_trips[${potentialIndex}].reserving_trip_obstruction=true for newly reserved trip ${finalNewlyReservedTripRef.id}.`);
                                 updateNestedTripField(neighborUpdate, 'potential_trips', potentialIndex, 'reserving_trip_obstruction', true);
                                 transaction.update(snap.ref, neighborUpdate);
                             } else {
                                 // GraphML says update matched_trips array, let's try that if not found in potential
                                 const matchedIndex = (neighborTrip.matched_trips || []).findIndex(mt => mt.trip_ref.id === finalNewlyReservedTripRef.id);
                                 if(matchedIndex !== -1){
                                     // This field doesn't exist on matched_trips per schema. Logging warning.
                                     logger.warn(`Node n35 wants to update reserving_trip_obstruction in matched_trips for ${snap.id}, but field does not exist there. Check GraphML.`);
                                     // Attempting to add to potential instead, mirroring n30 logic? No, n35 is simpler. Just logging the issue.
                                 } else {
                                     logger.warn(`Other neighbor ${snap.id}: Cannot find newly reserved trip ${finalNewlyReservedTripRef.id} in potential_trips (or matched_trips) to update reserving_trip_obstruction (n35).`);
                                 }
                             }
                         }
                     });
                 }
              } else {
                logger.info(`Newly reserved trip ${finalNewlyReservedTripRef.id} has no relevant neighbors for n29/n34 checks.`);
              }
            }
          }
        } else {
          logger.info(`Former reserving trip ${formerReservingTripRef!.id} has no other matched trips to reserve.`);
          // n22 -> n36: If no new trip to reserve AND the canceled trip was reserved by a paid trip
          if(wasPaidAndReserved && reservingTrip.trip_group_ref){
              logger.info(`Former reserving trip ${reservingTrip.trip_id} was paid and found no new trip to reserve. Cleaning up group ${reservingTrip.trip_group_ref.id}.`);
              // n36: Delete trip group
              transaction.delete(reservingTrip.trip_group_ref);

              // n37: Update former reserving trip
              transaction.update(formerReservingTripRef!, {
                  status: 'unmatched',
                  trip_group_ref: FieldValue.delete(),
                  time_of_payment: FieldValue.delete(),
                  total_seat_count: FieldValue.delete(),
              });

              // n38: Refund ticket (update user) - Needs user ID for former reserving trip
              const reservingUserId = reservingTrip.user_ref.id; // Assuming user_ref is present
              const reservingUserRef = db.collection('users').doc(reservingUserId);
              transaction.update(reservingUserRef, {
                  ticket_count: FieldValue.increment(1) // Assuming refund is 1 ticket
              });
              logger.info(`Refunded 1 ticket to user ${reservingUserId}.`);


             // n39: Update potential trips of the former reserving trip
             const potentialRefs = (reservingTrip.potential_trips || []).map(pt => pt.trip_ref);
             if (potentialRefs.length > 0) {
                 const potentialSnaps = await transaction.getAll(...potentialRefs);
                 potentialSnaps.forEach(pSnap => {
                     if (!pSnap.exists) return;
                     const potentialT = pSnap.data() as Trip;
                     const pUpdate: Record<string, any> = {};
                     const pIndex = (potentialT.potential_trips || []).findIndex(pt => pt.trip_ref.id === formerReservingTripRef!.id);
                     if (pIndex !== -1) {
                         logger.info(`Updating potential neighbor ${pSnap.id}: Clearing group info for former reserving trip ${formerReservingTripRef!.id} at index ${pIndex}.`);
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'paid', false);
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'trip_group_ref', null); // Or delete if allowed: FieldValue.delete()
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'trip_obstruction', false);
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'group_largest_pickup_overlap_gap', FieldValue.delete());
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'group_largest_destination_overlap_gap', FieldValue.delete());
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'total_seat_count', FieldValue.delete());
                         // Schema doesn't explicitly show seat_obstruction clear here, but likely intended
                         updateNestedTripField(pUpdate, 'potential_trips', pIndex, 'seat_obstruction', false);
                         transaction.update(pSnap.ref, pUpdate);
                     }
                 });
             }
          } else {
              logger.info(`Former reserving trip ${formerReservingTripRef!.id} was not paid or group ref missing, skipping group cleanup (n36-n39).`);
          }
        }
      });
      transactionPromises.push(newReservationTransactionPromise);
    }
  } else if (canceledTrip.status === 'canceled' && !canceledTrip.reserved) {
     // n21: NO path
     // Check if the reserving cleanup path (n36-n39) should run if canceled trip *wasn't* reserved but *was* paid?
     // The graph seems to link n36 only to the 'was reserved=YES' branch finding no replacement.
     // Assuming n36-n39 only run if the trip *was* reserved by a paid trip that now has no replacement.
     logger.info(`Canceled trip ${canceledTripId} was not reserved.`);
  }

  // --- n40: Junction ---

  // --- n41: Does cancelled trip have any paid potential_trip or paid matched_trip? ---
  const hadPaidNeighbors =
    matchedTrips.some(mt => mt.paid && mt.trip_group_ref) ||
    potentialTrips.some(pt => pt.paid && pt.trip_group_ref);

  if (hadPaidNeighbors) {
    logger.info(`Canceled trip ${canceledTripId} had paid neighbors.`);
    // n42: Get distinct trip groups from paid neighbors
    const distinctGroupRefs = new Map < string, DocumentReference > ();
    matchedTrips.forEach(mt => {
      if (mt.paid && mt.trip_group_ref && !distinctGroupRefs.has(mt.trip_group_ref.id)) {
        distinctGroupRefs.set(mt.trip_group_ref.id, mt.trip_group_ref);
      }
    });
    potentialTrips.forEach(pt => {
      if (pt.paid && pt.trip_group_ref && !distinctGroupRefs.has(pt.trip_group_ref.id)) {
        distinctGroupRefs.set(pt.trip_group_ref.id, pt.trip_group_ref);
      }
    });

    // n43: Remove canceled trip from potential_trip_members in each group
    const groupUpdatePromises = Array.from(distinctGroupRefs.values()).map(groupRef => {
      return db.runTransaction(async (transaction) => {
        const groupSnap = await transaction.get(groupRef);
        if (!groupSnap.exists) {
          logger.warn(`Paid neighbor group ${groupRef.id} not found.`);
          return;
        }
        const groupData = groupSnap.data() as TripGroup;
        const potentialMemberIndex = (groupData.potential_trip_members || []).findIndex(ptm => ptm.trip_ref.id === canceledTripId);
        if (potentialMemberIndex !== -1) {
          const elementToRemove = groupData.potential_trip_members[potentialMemberIndex];
          logger.info(`Removing canceled trip ${canceledTripId} from potential_trip_members of group ${groupRef.id}.`);
          transaction.update(groupRef, {
            potential_trip_members: FieldValue.arrayRemove(elementToRemove)
          });
        } else {
             logger.info(`Canceled trip ${canceledTripId} not found in potential_trip_members of group ${groupRef.id}.`);
        }
      });
    });
    transactionPromises.push(...groupUpdatePromises);
  } else {
     logger.info(`Canceled trip ${canceledTripId} had no paid neighbors.`);
  }

  // --- n44 onwards: Logic if the canceled trip *was* paid and in a group ---
  if (canceledTrip.trip_group_ref && beforeData.trip_group_ref && canceledTrip.status === 'canceled') {
    const tripGroupRef = canceledTrip.trip_group_ref;
    logger.info(`Canceled trip ${canceledTripId} was part of group ${tripGroupRef.id}. Processing group updates.`);

    const groupUpdateTransactionPromise = db.runTransaction(async (transaction) => {
      const groupSnap = await transaction.get(tripGroupRef);
      if (!groupSnap.exists) {
        logger.error(`Trip group ${tripGroupRef.id} not found for canceled trip ${canceledTripId}.`);
        // If group doesn't exist, maybe it was already deleted (e.g., by n36)?
        // Or data is inconsistent. For now, just log and exit this branch.
        return;
      }
      let tripGroup = groupSnap.data() as TripGroup;
      let groupUpdate: Record < string, any > = {};
      let remainingMembers: TripGroupMember[] = [];
      let remainingMemberRefs: DocumentReference[] = [];
      let remainingMemberTripsData: Trip[] = []; // Store fetched trip data
      let canceledMemberData: TripGroupMember | null = null;
      let canceledMemberIndex = -1;

      // n44: Mark member as canceled
      const members = tripGroup.trip_group_members || [];
      members.forEach((member, index) => {
        if (member.trip_ref.id === canceledTripId) {
          if (!member.canceled) { // Only update if not already marked
            logger.info(`Marking member ${canceledTripId} as canceled in group ${tripGroupRef.id}.`);
            updateNestedTripField(groupUpdate, 'trip_group_members', index, 'canceled', true);
            canceledMemberData = member;
            canceledMemberIndex = index;
          } else {
             canceledMemberData = member; // Still need data even if already marked
             canceledMemberIndex = index;
             logger.info(`Member ${canceledTripId} already marked as canceled in group ${tripGroupRef.id}.`);
          }
        } else if (!member.canceled) { // Collect non-canceled members
            remainingMembers.push(member);
            remainingMemberRefs.push(member.trip_ref);
        }
      });

      if (!canceledMemberData) {
          logger.warn(`Canceled trip ${canceledTripId} not found in group members of ${tripGroupRef.id}.`);
          // Cannot proceed with group logic without canceled member data (like seat_count)
          return;
      }
      const canceledTripSeatCount = canceledMemberData.seat_count;


      // n45: Was canceled trip the only member?
      if (members.length === 1 && members[0].trip_ref.id === canceledTripId) {
        logger.info(`Canceled trip ${canceledTripId} was the only member of group ${tripGroupRef.id}. Applying update and exiting group logic.`);
         if (Object.keys(groupUpdate).length > 0) { // Apply the 'canceled: true' update
            transaction.update(tripGroupRef, groupUpdate);
         }
         // Perhaps delete the group entirely here? Graph says end branch at n56.
        return; // End group processing for this transaction
      }

      // n46: Is there more than one trip left?
      if (remainingMembers.length === 0) {
         logger.info(`No members remaining in group ${tripGroupRef.id} after cancellation.`);
         // Group is effectively empty, maybe delete it? Graph implies just updating the canceled member and ending.
         if (Object.keys(groupUpdate).length > 0) {
            transaction.update(tripGroupRef, groupUpdate);
         }
         return;
      } else if (remainingMembers.length === 1) {
        logger.info(`Only one member remaining in group ${tripGroupRef.id}.`);
        const soleMember = remainingMembers[0];
        const soleMemberRef = soleMember.trip_ref;
        const soleMemberUserRef = soleMember.user_ref;
        const soleMemberSeatCount = soleMember.seat_count;

        // Need sole member's trip data
        const soleMemberTripSnap = await transaction.get(soleMemberRef);
        if (!soleMemberTripSnap.exists) {
           logger.warn(`Sole remaining member trip ${soleMemberRef.id} not found.`);
           // Apply group update and exit
           if (Object.keys(groupUpdate).length > 0) transaction.update(tripGroupRef, groupUpdate);
           return;
        }
        const soleMemberTrip = soleMemberTripSnap.data() as Trip;

        // n47: Does sole member have other matches?
        const hasOtherMatches = (soleMemberTrip.matched_trips || []).some(mt => mt.trip_ref.id !== canceledTripId);

        if (!hasOtherMatches) {
          logger.info(`Sole member ${soleMemberRef.id} has no other matches. Setting to unmatched.`);
          // n48: Update sole member's trip
          transaction.update(soleMemberRef, {
            status: 'unmatched',
            trip_group_ref: FieldValue.delete(),
            time_of_payment: FieldValue.delete(), // GraphML uses payment_time
            total_seat_count: FieldValue.delete(),
            // trip_alerts: FieldValue.arrayUnion({ // Needs user data for message
            //   message: `Trip member [${canceledMemberData.first_name}] just canceled their trip. No other matches currently available for your trip, your ticket has been refunded.`,
            //   seen: false,
            //   timestamp: FieldValue.serverTimestamp() // Add timestamp
            // })
          });
           logger.warn("Trip alert for sole member requires canceled user name/gender - skipping for now.");


          // n49: Notification placeholder
          logger.info(`PLACEHOLDER: Notify sole member ${soleMemberRef.id} about cancellation and refund.`);

          // n50, n51, n52: Refund ticket(s) - Logic is unclear (1 vs 1.5)
          const ticketsToRefund = soleMemberSeatCount > 1 ? 1.5 : 1; // GraphML logic
          logger.warn(`Refunding ${ticketsToRefund} tickets based on unclear GraphML logic (n50-n52). Using ${Math.ceil(ticketsToRefund)}.`);
          transaction.update(soleMemberUserRef, {
            ticket_count: FieldValue.increment(Math.ceil(ticketsToRefund)) // Use ceiling for whole tickets
          });
          logger.info(`Refunded ${Math.ceil(ticketsToRefund)} tickets to user ${soleMemberUserRef.id}.`);

        } else {
          logger.info(`Sole member ${soleMemberRef.id} still has other matches.`);
          // n53: Update sole member's trip (total_seat_count, alert)
           const newTotalSeats = (soleMemberTrip.total_seat_count ?? canceledTripSeatCount) - canceledTripSeatCount; // Calculate remaining seats
           transaction.update(soleMemberRef, {
             total_seat_count: newTotalSeats,
            // trip_alerts: FieldValue.arrayUnion({ // Needs user data
            //   message: `Trip group member [${canceledMemberData.first_name}] just canceled their trip, matches are still available for your trip.`,
            //   seen: false,
            //   timestamp: FieldValue.serverTimestamp()
            // })
          });
           logger.warn("Trip alert for sole member (n53) requires canceled user name/gender - skipping for now.");
           logger.info(`Updated sole member ${soleMemberRef.id} total_seat_count to ${newTotalSeats}.`);


          // n54: Notification placeholder
          logger.info(`PLACEHOLDER: Notify sole member ${soleMemberRef.id} about cancellation (matches still available).`);
          // Fall through to common group updates (n55 onwards) ? GraphML seems to imply this path also continues.
        }
          // --- CONTINUES TO COMMON GROUP UPDATES ---
      } else {
         // n46: YES (More than one member remaining)
         logger.info(`${remainingMembers.length} members remaining in group ${tripGroupRef.id}.`);
          // n86: Update total_seat_count on remaining members' trip documents
          const newTotalSeatCount = remainingMembers.reduce((sum, member) => sum + member.seat_count, 0);
          logger.info(`New total seat count for group ${tripGroupRef.id}: ${newTotalSeatCount}`);
          remainingMemberRefs.forEach(ref => {
             transaction.update(ref, { total_seat_count: newTotalSeatCount });
             logger.info(`Updating remaining member ${ref.id} total_seat_count to ${newTotalSeatCount}.`);
          });
          // n53 logic for multiple members (alert) - requires user data for canceled trip
          // n54 notification placeholder
           logger.warn("Trip alert for remaining members (n53) requires canceled user name/gender - skipping for now.");
           logger.info(`PLACEHOLDER: Notify remaining members of group ${tripGroupRef.id} about cancellation (matches still available).`);

         // --- CONTINUES TO COMMON GROUP UPDATES ---
      }

        // --- Common Group Updates (Executed if >0 members remain) ---

        // n55: Update trip_group's total_seat_count
       const finalTotalSeatCount = remainingMembers.reduce((sum, member) => sum + member.seat_count, 0);
        if (tripGroup.total_seat_count !== finalTotalSeatCount) {
           groupUpdate['total_seat_count'] = finalTotalSeatCount;
           logger.info(`Updating group ${tripGroupRef.id} total_seat_count to ${finalTotalSeatCount}.`);
        }


       // Need data for remaining members' trips for potential member re-evaluation
       if (remainingMemberRefs.length > 0) {
            const remainingTripSnaps = await transaction.getAll(...remainingMemberRefs);
            remainingTripSnaps.forEach(snap => {
                if (snap.exists) {
                    remainingMemberTripsData.push(snap.data() as Trip);
                } else {
                    logger.warn(`Remaining member trip ${snap.id} not found during transaction.`);
                }
            });
       }


        // n56: Get potential_trip_members with trip_obstruction or seat_obstruction
       const potentialMembersToReEvaluate = (tripGroup.potential_trip_members || []).filter(
           ptm => ptm.trip_obstruction || ptm.seat_obstruction
       );

       if (potentialMembersToReEvaluate.length > 0 && remainingMemberTripsData.length > 0) {
           logger.info(`Re-evaluating ${potentialMembersToReEvaluate.length} potential members for group ${tripGroupRef.id}.`);

           // Need data for the potential members' trips
           const potentialMemberTripRefs = potentialMembersToReEvaluate.map(ptm => ptm.trip_ref);
           const potentialTripSnaps = await transaction.getAll(...potentialMemberTripRefs);
           const potentialTripsDataMap = new Map<string, Trip>();
            potentialTripSnaps.forEach(snap => {
                if(snap.exists) potentialTripsDataMap.set(snap.id, snap.data() as Trip);
                else logger.warn(`Potential member trip ${snap.id} not found.`);
            });


           // n57: For each potential_trip_member
           potentialMembersToReEvaluate.forEach((ptm, ptmIndexOriginal) => {
               const potentialTripData = potentialTripsDataMap.get(ptm.trip_ref.id);
               if (!potentialTripData) return; // Skip if trip data missing

               // Find the original index in the group's array
               const originalGroupPtmIndex = (tripGroup.potential_trip_members || []).findIndex(origPtm => origPtm.trip_ref.id === ptm.trip_ref.id);
               if (originalGroupPtmIndex === -1) return;


               // n58: Declare variables
               let tripObstruction = false;
               let unknownTripObstruction = false; // Default false based on n60, n66, n75
               let seatObstruction = false; // Default false based on n79
               let largestPickupGap = 0;
               let largestDestGap = 0;
               let remainingObstructingMembers: ObstructingTripMember[] = [];

               // Recalculate obstructions based on *remaining* members
               ptm.obstructing_trip_members = ptm.obstructing_trip_members || []; // Ensure array exists

               // n61: Is canceled trip one of the obstructing members?
               const obstructingCanceledIndex = ptm.obstructing_trip_members.findIndex(obs => obs.trip_ref.id === canceledTripId);
               const wasObstructedByCanceled = obstructingCanceledIndex !== -1;
               const canceledObstructionData = wasObstructedByCanceled ? ptm.obstructing_trip_members[obstructingCanceledIndex] : null;

               if (wasObstructedByCanceled) {
                  logger.info(`Potential member ${ptm.trip_ref.id}: Canceled trip ${canceledTripId} was an obstructing member.`);
                   // n62: Remove canceled trip from obstructing_trip_members list in the GROUP update
                   const obstructingMemberToRemove = ptm.obstructing_trip_members[obstructingCanceledIndex];
                   const groupPtmUpdatePath = `potential_trip_members.${originalGroupPtmIndex}.obstructing_trip_members`;
                   groupUpdate[groupPtmUpdatePath] = FieldValue.arrayRemove(obstructingMemberToRemove);
                   // Get remaining obstructing members *after* removal
                   remainingObstructingMembers = ptm.obstructing_trip_members.filter((_, i) => i !== obstructingCanceledIndex);
               } else {
                  // Canceled wasn't obstructing, keep existing list for gap calculation
                  remainingObstructingMembers = ptm.obstructing_trip_members;
               }


               // Recalculate trip_obstruction based on remaining obstructing members
               tripObstruction = remainingObstructingMembers.some(obs => !obs.unknown); // Trip obstructed if any known obstruction remains

               // n63: Was canceled trip the only obstructing member? (Check length *after* potential removal)
               const wasOnlyObstruction = wasObstructedByCanceled && remainingObstructingMembers.length === 0;

                if (wasOnlyObstruction) {
                    // n66: tripObstruction = false; unknownTripObstruction = false;
                    tripObstruction = false;
                    unknownTripObstruction = false;
                   logger.info(`Potential member ${ptm.trip_ref.id}: Canceled trip was only obstruction. tripObstruction=false.`);

                    // n65: Clear gaps on the POTENTIAL TRIP'S document
                   const potentialTripUpdate: Record<string, any> = {};
                   const potentialTripArrayIndex = (potentialTripData.potential_trips || []).findIndex(pt => pt.trip_group_ref ?.id === tripGroupRef.id);
                   if (potentialTripArrayIndex !== -1) {
                        logger.info(`Potential member ${ptm.trip_ref.id}: Clearing group gaps in its potential_trips array (index ${potentialTripArrayIndex}).`);
                        updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_pickup_overlap_gap', FieldValue.delete());
                        updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_destination_overlap_gap', FieldValue.delete());
                        transaction.update(ptm.trip_ref, potentialTripUpdate);
                   }
                } else if (remainingObstructingMembers.length > 0) {
                    // n67 -> n81 path if other obstructions exist or canceled wasn't obstructing
                    tripObstruction = remainingObstructingMembers.some(obs => !obs.unknown); // Set based on remaining known obstructions
                   logger.info(`Potential member ${ptm.trip_ref.id}: Has remaining obstructions or canceled wasn't obstructing. tripObstruction=${tripObstruction}.`);

                   // n68: Was canceled trip an unknown obstruction?
                   const wasUnknownObstructionByCanceled = canceledObstructionData ?.unknown ?? false;

                   // Calculate new largest gaps from *remaining* obstructing members (n71) only if there are remaining known obstructions
                   if (tripObstruction) {
                        remainingObstructingMembers.forEach(obs => {
                           if (!obs.unknown) {
                               largestPickupGap = Math.max(largestPickupGap, obs.pickup_overlap_gap ?? 0);
                               largestDestGap = Math.max(largestDestGap, obs.destination_overlap_gap ?? 0);
                           }
                       });
                       logger.info(`Potential member ${ptm.trip_ref.id}: Recalculated gaps: Gp=${largestPickupGap}, Gd=${largestDestGap}.`);

                        // n72: Update gaps on POTENTIAL TRIP'S document
                       const potentialTripUpdate: Record<string, any> = {};
                       const potentialTripArrayIndex = (potentialTripData.potential_trips || []).findIndex(pt => pt.trip_group_ref ?.id === tripGroupRef.id);
                       if (potentialTripArrayIndex !== -1) {
                           logger.info(`Potential member ${ptm.trip_ref.id}: Updating group gaps in its potential_trips array (index ${potentialTripArrayIndex}).`);
                           updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_pickup_overlap_gap', largestPickupGap);
                           updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_destination_overlap_gap', largestDestGap);
                           transaction.update(ptm.trip_ref, potentialTripUpdate);
                       }
                   } else {
                        // No remaining *known* obstructions, clear gaps (similar to n65)
                       const potentialTripUpdate: Record<string, any> = {};
                       const potentialTripArrayIndex = (potentialTripData.potential_trips || []).findIndex(pt => pt.trip_group_ref ?.id === tripGroupRef.id);
                       if (potentialTripArrayIndex !== -1) {
                            logger.info(`Potential member ${ptm.trip_ref.id}: Clearing group gaps as no known obstructions remain.`);
                            updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_pickup_overlap_gap', FieldValue.delete());
                            updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_destination_overlap_gap', FieldValue.delete());
                            transaction.update(ptm.trip_ref, potentialTripUpdate);
                       }
                   }


                    // Determine unknownTripObstruction status
                   if (wasUnknownObstructionByCanceled) {
                       // n73: Was canceled the *only* unknown obstruction?
                       const hasOtherUnknown = remainingObstructingMembers.some(obs => obs.unknown);
                       if (hasOtherUnknown) { // n74
                           unknownTripObstruction = true;
                       } else { // n75
                           unknownTripObstruction = false;
                           // n76: Update unknown_trip_obstruction in GROUP doc
                           const groupPtmUpdatePath = `potential_trip_members.${originalGroupPtmIndex}.unknown_trip_obstruction`;
                           groupUpdate[groupPtmUpdatePath] = false;
                          logger.info(`Potential member ${ptm.trip_ref.id}: Canceled was only unknown obstruction. Setting unknown_trip_obstruction=false in group.`);
                       }
                   } else {
                       // Canceled wasn't unknown, check if any remaining are
                       unknownTripObstruction = remainingObstructingMembers.some(obs => obs.unknown);
                   }
                    logger.info(`Potential member ${ptm.trip_ref.id}: Final unknownTripObstruction=${unknownTripObstruction}.`);

                } else { // No remaining obstructions at all
                    tripObstruction = false;
                    unknownTripObstruction = false;
                    logger.info(`Potential member ${ptm.trip_ref.id}: No remaining obstructions. tripObstruction=false, unknownTripObstruction=false.`);
                    // Clear gaps (like n65)
                    const potentialTripUpdate: Record<string, any> = {};
                   const potentialTripArrayIndex = (potentialTripData.potential_trips || []).findIndex(pt => pt.trip_group_ref ?.id === tripGroupRef.id);
                   if (potentialTripArrayIndex !== -1) {
                        logger.info(`Potential member ${ptm.trip_ref.id}: Clearing group gaps as no obstructions remain.`);
                        updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_pickup_overlap_gap', FieldValue.delete());
                        updateNestedTripField(potentialTripUpdate, 'potential_trips', potentialTripArrayIndex, 'group_largest_destination_overlap_gap', FieldValue.delete());
                        transaction.update(ptm.trip_ref, potentialTripUpdate);
                   }
                }

               // Recalculate seat_obstruction (n78/n79)
               seatObstruction = (finalTotalSeatCount + (potentialTripData.seat_count ?? 1)) > 4; // Assuming max 4 seats
                logger.info(`Potential member ${ptm.trip_ref.id}: Seat obstruction check: ${finalTotalSeatCount} + ${potentialTripData.seat_count ?? 1} > 4 ? ${seatObstruction}.`);


               // n80: Update potential member status in the GROUP document
               const groupPtmUpdatePathPrefix = `potential_trip_members.${originalGroupPtmIndex}`;
               groupUpdate[`${groupPtmUpdatePathPrefix}.trip_obstruction`] = tripObstruction;
               groupUpdate[`${groupPtmUpdatePathPrefix}.unknown_trip_obstruction`] = unknownTripObstruction; // Ensure this is updated if n76 path wasn't taken
               groupUpdate[`${groupPtmUpdatePathPrefix}.seat_obstruction`] = seatObstruction;
                logger.info(`Potential member ${ptm.trip_ref.id}: Updating status in group doc: tripObs=${tripObstruction}, unknownObs=${unknownTripObstruction}, seatObs=${seatObstruction}.`);


                // Update the corresponding entry in the POTENTIAL TRIP's potential_trips array
                const potentialTripUpdateForStatus: Record<string, any> = {};
                const potentialTripArrayIndex = (potentialTripData.potential_trips || []).findIndex(pt => pt.trip_group_ref?.id === tripGroupRef.id);
                if(potentialTripArrayIndex !== -1) {
                     logger.info(`Potential member ${ptm.trip_ref.id}: Updating obstruction status in its potential_trips array (index ${potentialTripArrayIndex}).`);
                    updateNestedTripField(potentialTripUpdateForStatus, 'potential_trips', potentialTripArrayIndex, 'trip_obstruction', tripObstruction);
                    updateNestedTripField(potentialTripUpdateForStatus, 'potential_trips', potentialTripArrayIndex, 'unknown_trip_obstruction', unknownTripObstruction);
                    updateNestedTripField(potentialTripUpdateForStatus, 'potential_trips', potentialTripArrayIndex, 'seat_obstruction', seatObstruction);
                    updateNestedTripField(potentialTripUpdateForStatus, 'potential_trips', potentialTripArrayIndex, 'total_seat_count', finalTotalSeatCount); // n84 total_seat_count update
                    transaction.update(ptm.trip_ref, potentialTripUpdateForStatus);
                }


               // n81: Are both tripObstruction AND seatObstruction false?
               if (!tripObstruction && !seatObstruction) {
                   logger.info(`Potential member ${ptm.trip_ref.id} is no longer obstructed. Promoting to matched.`);
                   // n82: Promote potential trip to matched status
                   const potentialTripUpdatePromotion: Record<string, any> = {};
                   const elementsToRemoveFromPotential: PotentialTrip[] = [];
                   const elementsToAddToMatched: MatchedTrip[] = [];

                   // Find existing potential_trips entries pointing to remaining group members
                   const potentialEntriesForGroup = (potentialTripData.potential_trips || []).filter(
                       pt => remainingMemberRefs.some(ref => ref.id === pt.trip_ref.id)
                   );

                   potentialEntriesForGroup.forEach(ptEntry => {
                       elementsToRemoveFromPotential.push(ptEntry); // Mark for removal

                       // Find corresponding remaining member trip data
                       const memberTripData = remainingMemberTripsData.find(t => t.trip_id === ptEntry.trip_ref.id);
                       if (!memberTripData) return;

                       const newMatchedEntry: MatchedTrip = {
                           trip_ref: ptEntry.trip_ref,
                           trip_group_ref: tripGroupRef, // Now part of the group
                           paid: true, // Group members are paid
                           pickup_radius: memberTripData.pickup_radius, // n82 relevant value
                           destination_radius: memberTripData.destination_radius, // n82 relevant value
                           pickup_distance: ptEntry.pickup_distance, // Use existing
                           destination_distance: ptEntry.destination_distance, // Use existing
                           mutual: !ptEntry.mutual, // n82: !mutual of deleted potential
                           reserving: false, // n82: reserving: false
                           seat_count: memberTripData.seat_count // Schema requires
                       };
                       elementsToAddToMatched.push(newMatchedEntry);
                       logger.info(`Potential member ${ptm.trip_ref.id}: Preparing to add group member ${ptEntry.trip_ref.id} to matched_trips with mutual=${!ptEntry.mutual}.`);
                   });

                   if (elementsToRemoveFromPotential.length > 0) {
                       potentialTripUpdatePromotion['potential_trips'] = FieldValue.arrayRemove(...elementsToRemoveFromPotential);
                   }
                   if (elementsToAddToMatched.length > 0) {
                       potentialTripUpdatePromotion['matched_trips'] = FieldValue.arrayUnion(...elementsToAddToMatched);
                   }

                   if (Object.keys(potentialTripUpdatePromotion).length > 0) {
                       transaction.update(ptm.trip_ref, potentialTripUpdatePromotion);
                       logger.info(`Updating potential trip ${ptm.trip_ref.id} doc: removing from potential, adding to matched.`);
                   }


                   // n83: Update mutual flags on the remaining group members' trips
                   remainingMemberTripsData.forEach(memberTrip => {
                       const memberTripUpdate: Record<string, any> = {};
                       let memberChanged = false;

                       // Check potential trips first
                       const potIndex = (memberTrip.potential_trips || []).findIndex(pt => pt.trip_ref.id === ptm.trip_ref.id);
                       if (potIndex !== -1) {
                           const currentMutual = memberTrip.potential_trips[potIndex].mutual;
                           logger.info(`Updating remaining member ${memberTrip.trip_id}: Setting potential_trips[${potIndex}] (for ${ptm.trip_ref.id}) mutual=${!currentMutual}.`);
                           updateNestedTripField(memberTripUpdate, 'potential_trips', potIndex, 'mutual', !currentMutual);
                           memberChanged = true;
                       } else {
                           // Check matched trips if not in potential
                           const matIndex = (memberTrip.matched_trips || []).findIndex(mt => mt.trip_ref.id === ptm.trip_ref.id);
                           if (matIndex !== -1) {
                               const currentMutual = memberTrip.matched_trips[matIndex].mutual;
                               logger.info(`Updating remaining member ${memberTrip.trip_id}: Setting matched_trips[${matIndex}] (for ${ptm.trip_ref.id}) mutual=${!currentMutual}.`);
                               updateNestedTripField(memberTripUpdate, 'matched_trips', matIndex, 'mutual', !currentMutual);
                               memberChanged = true;
                           } else {
                               logger.warn(`Cannot find promoted trip ${ptm.trip_ref.id} in remaining member ${memberTrip.trip_id}'s arrays for mutual update (n83).`);
                           }
                       }

                       if (memberChanged) {
                           transaction.update(db.doc(memberTrip.user_ref.path + '/trips/' + memberTrip.trip_id), memberTripUpdate);
                       }
                   });

               }
               // End of loop for one potential member (n57)
           });
           // End of potential member re-evaluation block (n56-n85)
       } else {
           logger.info(`No potential members to re-evaluate or no remaining members in group ${tripGroupRef.id}.`);
       }


        // --- n87-n103: Suggestion/Time Recalculation ---
        // THIS SECTION IS COMPLEX AND INVOLVES EXTERNAL APIs - Placeholder Implementation
        let newPickupSuggestions = false;
        let newDestinationSuggestions = false; // GraphML doesn't detail this, assume false for now
        let timeRangeArrayChanged = false;
        let tripGroupTimeRangeArrayFormatted: string[] = [];
        let tripGroupTimeRangeArrayUnion: string[] = []; // Store original union for comparison

        if (remainingMembers.length >= 1) { // Need at least one member for time ranges etc.
             // Calculate original time range union (before cancellation) for comparison (n100)
             const originalTimeArrays = (tripGroup.trip_group_members || [])
                .filter(m => !m.canceled || m.trip_ref.id === canceledTripId) // Include canceled trip for original state
                .map(m => m.time_range_array || []);
            const originalTimeUnion = arrayUnion(...originalTimeArrays);

            // Calculate new time range union
             const newTimeArrays = remainingMembers.map(m => m.time_range_array || []);
             tripGroupTimeRangeArrayUnion = arrayUnion(...newTimeArrays); // Store for n101

            // n100: Check if time range union length decreased (meaning canceled trip provided unique slots)
            // GraphML says "<", implying if union *shrank* or stayed same, no change? Let's assume length changed *at all*.
            // Or maybe it means the *new* union is smaller than the original? No, GraphML says "<" comparing length *before* vs *after*. This means the *new* length is LESS THAN the *old* length. Let's correct interpretation:
            // Length BEFORE < Length AFTER? Means the union expanded? This seems counter-intuitive on removal.
            // Let's assume the check is simply: Did the union *change*?
             const unionChanged = JSON.stringify(originalTimeUnion) !== JSON.stringify(tripGroupTimeRangeArrayUnion);


            if (unionChanged) { // n100 YES path modified interpretation
                 logger.info(`Group ${tripGroupRef.id} time range union changed.`);
                timeRangeArrayChanged = true; // n103
                // n102: Format the NEW union
                tripGroupTimeRangeArrayFormatted = formatTimeRangeArray(tripGroupTimeRangeArrayUnion);
                logger.info(`Formatted time range: ${tripGroupTimeRangeArrayFormatted.join(', ')}`);
            } else {
                logger.info(`Group ${tripGroupRef.id} time range union did not change.`);
            }


            // --- Placeholder for Pickup Suggestion Logic (n88-n99) ---
            logger.warn("Pickup suggestion recalculation (n88-n99) involves external APIs and complex logic - SKIPPED. Setting newPickupSuggestions=false.");
            // Set newPickupSuggestions = true if logic were implemented and suggestions changed.

            // --- Placeholder for Destination Suggestion Logic ---
            logger.warn("Destination suggestion recalculation involves external APIs and complex logic - SKIPPED. Setting newDestinationSuggestions=false.");
            // Set newDestinationSuggestions = true if logic were implemented and suggestions changed.
        }


       // n101: Create system message if needed
       if (Object.keys(groupUpdate).length > 0 || newPickupSuggestions || newDestinationSuggestions || timeRangeArrayChanged) {
           // Apply the collected updates to the group document first
           logger.info(`Applying updates to group document ${tripGroupRef.id}:`, groupUpdate);
           transaction.update(tripGroupRef, groupUpdate);


           // Now create the message
           const messagesColRef = tripGroupRef.collection('messages');
           const newMessageRef = messagesColRef.doc(); // Auto-generate ID
           const systemMessage: Message = {
               message_id: newMessageRef.id, // Add message ID
               message_ref: newMessageRef, // Add message ref
               message_type: 'system',
               user_ref: userRef, // Reference to the user who initiated the cancellation action
               message: `Trip group member [${canceledMemberData?.first_name ?? 'User'}] just canceled their trip.`, // Simplified message
               timestamp: Timestamp.now(), // Use server timestamp if possible outside transaction, or client time now
               // audio, image - N/A
               photo_url: canceledTrip.user_ref ? (await transaction.get(canceledTrip.user_ref)).data()?.photo_url : undefined, // Fetch user photo if needed
               first_name: canceledMemberData?.first_name ?? 'System',
               last_name: canceledMemberData?.last_name ?? '',
               seenBy: [], // Initially unseen
               newly_paid_trip_ref: null, // N/A here (GraphML used NPT?) - Setting null
               redundant: false,
               system_message: true,
               new_pickup_suggestion: newPickupSuggestions, // Use calculated flag
               new_destination_suggestion: newDestinationSuggestions, // Use calculated flag
               group_time_range_array_changed: timeRangeArrayChanged, // Use calculated flag
               group_time_range_array: timeRangeArrayChanged ? tripGroupTimeRangeArrayFormatted : [], // Use formatted array if changed
           };
           logger.warn("System message requires canceled user data (name, photo) - using defaults if unavailable.");
           logger.info(`Creating system message in group ${tripGroupRef.id}:`, systemMessage);
           transaction.set(newMessageRef, systemMessage);

           // Update recent_message on the group
           const recentMessageUpdate : RecentMessage = {
                message_id: newMessageRef.id,
                message_ref: newMessageRef,
                message_type: systemMessage.message_type,
                message: systemMessage.message,
                user_ref: systemMessage.user_ref,
                from_first_name: systemMessage.first_name,
                timestamp: systemMessage.timestamp, // Use same timestamp
                seenBy: []
           };
           transaction.update(tripGroupRef, { recent_message: recentMessageUpdate });


       } else {
            logger.info(`No significant changes to group ${tripGroupRef.id}, skipping system message creation.`);
       }

        // n104-n126: Notification Placeholders (logic based on flags)
        if (!newPickupSuggestions && !newDestinationSuggestions && !timeRangeArrayChanged) {
            logger.info("PLACEHOLDER (n105): Notify remaining members - Basic cancellation.");
        } else if (!newPickupSuggestions && !newDestinationSuggestions && timeRangeArrayChanged) {
            if (tripGroupTimeRangeArrayFormatted.length > 1) {
                 logger.info(`PLACEHOLDER (n109): Notify remaining members - Cancellation + Time Range changed: ${tripGroupTimeRangeArrayFormatted[0]} - ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length-1]}`);
            } else {
                 logger.info(`PLACEHOLDER (n108): Notify remaining members - Cancellation + Time Fixed: ${tripGroupTimeRangeArrayFormatted[0]}`);
            }
        } else if (!newPickupSuggestions && newDestinationSuggestions && !timeRangeArrayChanged) {
            logger.info("PLACEHOLDER (n111): Notify remaining members - Cancellation + New Destination Suggestions.");
        } else if (!newPickupSuggestions && newDestinationSuggestions && timeRangeArrayChanged) {
             if (tripGroupTimeRangeArrayFormatted.length > 1) {
                 logger.info(`PLACEHOLDER (n115): Notify remaining members - Cancellation + Dest Suggestions + Time Range changed: ${tripGroupTimeRangeArrayFormatted[0]} - ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length-1]}`);
             } else {
                 logger.info(`PLACEHOLDER (n114): Notify remaining members - Cancellation + Dest Suggestions + Time Fixed: ${tripGroupTimeRangeArrayFormatted[0]}`);
             }
        } else if (newPickupSuggestions && !newDestinationSuggestions && !timeRangeArrayChanged) {
             logger.info("PLACEHOLDER (n117): Notify remaining members - Cancellation + New Pickup Suggestions.");
        } else if (newPickupSuggestions && !newDestinationSuggestions && timeRangeArrayChanged) {
            if (tripGroupTimeRangeArrayFormatted.length > 1) {
                // Note: GraphML n120 uses LAST element, n125 uses FIRST-LAST. Using FIRST-LAST.
                logger.info(`PLACEHOLDER (n121 - like n125): Notify remaining members - Cancellation + Pickup Suggestions + Time Range changed: ${tripGroupTimeRangeArrayFormatted[0]} - ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length-1]}`);
            } else {
                logger.info(`PLACEHOLDER (n120): Notify remaining members - Cancellation + Pickup Suggestions + Time Fixed: ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length - 1]}`); // Graph uses last element
            }
        } else if (newPickupSuggestions && newDestinationSuggestions && !timeRangeArrayChanged) {
            logger.info("PLACEHOLDER (n123): Notify remaining members - Cancellation + Both Suggestions.");
        } else { // Both suggestions AND time changed
             if (tripGroupTimeRangeArrayFormatted.length > 1) {
                 logger.info(`PLACEHOLDER (n125): Notify remaining members - Cancellation + Both Suggestions + Time Range changed: ${tripGroupTimeRangeArrayFormatted[0]} - ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length-1]}`);
             } else {
                 logger.info(`PLACEHOLDER (n126): Notify remaining members - Cancellation + Both Suggestions + Time Fixed: ${tripGroupTimeRangeArrayFormatted[tripGroupTimeRangeArrayFormatted.length - 1]}`); // Graph uses last element
             }
        }


    }); // End of group update transaction
    transactionPromises.push(groupUpdateTransactionPromise);

  } else {
      logger.info(`Canceled trip ${canceledTripId} was not part of a group or group reference missing.`);
  }


  // --- Commit Batch and Await Transactions ---
  try {
    await batch.commit();
    logger.info("Batch updates committed successfully.");
    await Promise.all(transactionPromises);
    logger.info("All transactions completed successfully.");
  } catch (error) {
    logger.error("Error committing batch or executing transactions:", error);
    if (error instanceof Error) {
        // Rethrow as HttpsError if needed, or just log for background function
        logger.error("Detailed error:", error.message, error.stack);
    } else {
         logger.error("Unknown error structure:", error);
    }
    // Depending on the error, might need rollback logic if possible,
    // but Firestore transactions auto-rollback on failure. Batch writes are not atomic across the batch.
    throw error; // Rethrow to indicate failure for Cloud Functions monitoring
  }

  logger.info(`tripCanceled function finished for ${canceledTripId}.`);
  return null; // Indicate successful completion
});


// --- Type Definitions Placeholder ---
// Define interfaces User, Trip, MatchedTrip, PotentialTrip, TripGroup, TripGroupMember,
// PotentialTripMember, ObstructingTripMember, PickupLocationSuggestion, DestinationSuggestion,
// DistanceFromLocation, RecentMessage, Message, LatLng here or import from './types'



// --- End of Type Definitions ---