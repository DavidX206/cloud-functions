
import * as logger from "firebase-functions/logger";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import * as admin from "firebase-admin";
import { FieldValue, DocumentReference } from "firebase-admin/firestore";
import { Trip, PotentialTrip} from "../../../type";
import { properMatchGeometric, getStoredDistances, findTripIndex, updateNestedTripField } from '../utils/utils';
import { db } from "../firebaseAdmin";

// --- Cloud Function: handleReservationCascade ---

interface ReservationCascadePayload {
    newlyReservedTripPath: string;
    reservingTripPath: string;
}

export const handleReservationCascade = onTaskDispatched<ReservationCascadePayload>(
    {
        retryConfig: {
            maxAttempts: 5,
            minBackoffSeconds: 10,
        },
        rateLimits: {
            maxConcurrentDispatches: 10, // Adjust as needed
        },
        // Define queue options if creating the queue via Firebase CLI / Function config
        // queueOptions: {
        //    name: "reservation-cascade-queue", // Make sure this matches TASKS_QUEUE_ID
        //    retryConfig: {...} // Can also define retry here
        // }
    },
    async (request) => {
        const { newlyReservedTripPath, reservingTripPath } = request.data;
        logger.info(`handleReservationCascade triggered for newlyReserved: ${newlyReservedTripPath}, reserver: ${reservingTripPath}`);

        if (!newlyReservedTripPath || !reservingTripPath) {
            logger.error("Missing newlyReservedTripPath or reservingTripPath in payload.");
            // Acknowledge the task to prevent retries for bad payload
            return;
        }

        const newlyReservedTripRef = db.doc(newlyReservedTripPath) as DocumentReference<Trip>;
        const reservingTripRef = db.doc(reservingTripPath) as DocumentReference<Trip>;

        try {
             // Fetch the main trips involved (outside transaction for initial read)
             const newlyReservedTripSnap = await newlyReservedTripRef.get();
             const reservingTripSnap = await reservingTripRef.get();

             if (!newlyReservedTripSnap.exists || !reservingTripSnap.exists) {
                 logger.error(`Newly reserved trip (${newlyReservedTripPath}) or reserving trip (${reservingTripPath}) not found. Cannot process cascade.`);
                 return; // Acknowledge task
             }

             const newlyReservedTripData = newlyReservedTripSnap.data() as Trip;
             const reservingTripData = reservingTripSnap.data() as Trip;

             // --- Implement n22-n28 Logic ---

             // Identify potentially affected trips from the newly reserved trip's perspective
             const relatedMatched = newlyReservedTripData.matched_trips || [];
             const relatedPotential = newlyReservedTripData.potential_trips || [];
             const allRelatedRefs = new Map<string, { tripRef: DocumentReference, type: 'matched' | 'potential', originalMutual: boolean }>();

             relatedMatched.forEach(m => {
                 if (m.trip_ref.path !== reservingTripRef.path) { // Exclude the reserver itself
                     allRelatedRefs.set(m.trip_ref.path, { tripRef: m.trip_ref, type: 'matched', originalMutual: m.mutual });
                 }
             });
             relatedPotential.forEach(p => {
                  if (p.trip_ref.path !== reservingTripRef.path && !allRelatedRefs.has(p.trip_ref.path)) { // Exclude reserver, don't overwrite if matched
                     allRelatedRefs.set(p.trip_ref.path, { tripRef: p.trip_ref, type: 'potential', originalMutual: p.mutual });
                  }
             });

             logger.info(`Found ${allRelatedRefs.size} related trips to check for cascade effects.`);

             for (const [relatedPath, { tripRef: relatedTripRef, type: originalType, originalMutual }] of allRelatedRefs) {
                 await db.runTransaction(async (transaction) => {
                     logger.info(`Processing related trip ${relatedPath} in transaction.`);

                      // Fetch fresh data within transaction
                     const relatedTripSnap = await transaction.get(relatedTripRef);
                     const freshNewlyReservedSnap = await transaction.get(newlyReservedTripRef); // Re-fetch in case of concurrent updates

                     if (!relatedTripSnap.exists || !freshNewlyReservedSnap.exists) {
                         logger.warn(`Related trip ${relatedPath} or newly reserved trip ${newlyReservedTripPath} disappeared during transaction. Skipping.`);
                         return;
                     }
                     const relatedTripData = relatedTripSnap.data() as Trip;
                     const currentNewlyReservedData = freshNewlyReservedSnap.data() as Trip; // Use this for updates

                     // Check if related trip proper matches the *new* reserving trip
                     const distance = getStoredDistances(relatedTripData, reservingTripRef);
                     const relatedMatchesReserver = distance ? properMatchGeometric(relatedTripData, reservingTripData, distance.pickupDistance, distance.destinationDistance) : false;

                     if (!relatedMatchesReserver) {
                         logger.info(`Related trip ${relatedPath} does NOT proper match new reserver ${reservingTripPath}. Applying cascade.`);

                         // Graph Logic Split based on original relationship type/mutual status
                         // n22-n26 Group: Was mutual match OR non-mutual potential (where ET saw it as potential)
                         // n27-n28 Group: Was non-mutual match OR mutual potential (where ET saw it as matched)
                         // This interpretation is based on how 'mutual' reflects the *other* trip's view.

                         const isGroup1 = (originalType === 'matched' && originalMutual) || (originalType === 'potential' && !originalMutual);
                         const isGroup2 = (originalType === 'matched' && !originalMutual) || (originalType === 'potential' && originalMutual);

                         const relatedTripUpdate: Record<string, any> = {};
                         let newlyReservedTripUpdate: Record<string, any> = {}; // Changes needed for newly reserved trip's arrays


                         if (isGroup1) {
                              const distance = getStoredDistances(relatedTripData, newlyReservedTripRef);
                              if (!distance) {
                                    logger.error(`Could not calculate distances for ${relatedPath} and ${newlyReservedTripPath}. Skipping cascade for this trip.`);
                                    return;
                                }
                              // n23: Update Related Trip: Delete from matched, add to potential
                              logger.info(`Applying Group 1 (n23) logic to ${relatedPath}.`);
                              const potentialEntryForRelated: PotentialTrip = {
                                 trip_ref: newlyReservedTripRef,
                                 paid: false, // Assuming newly reserved trip might not be paid in context of others? Or use actual status? Graph says false.
                                 trip_group_ref: null, // As per graph
                                 pickup_radius: currentNewlyReservedData.pickup_radius,
                                 destination_radius: currentNewlyReservedData.destination_radius,
                                 // Distances need to be fetched/calculated if not stored reliably
                                 pickup_distance: distance.pickupDistance,
                                 destination_distance: distance.destinationDistance,
                                 proper_match: true, // Still matches newly reserved trip geometrically
                                 trip_obstruction: false,
                                 seat_obstruction: false,
                                 reserving_trip_obstruction: true, // Now obstructed by the new reservation
                                 mutual: !originalMutual, // Flip mutual
                                 group_largest_pickup_overlap_gap: null,
                                 group_largest_destination_overlap_gap: null,
                                 unknown_trip_obstruction: false,
                                 total_seat_count: null,
                                 seat_count: currentNewlyReservedData.seat_count, // Assuming this is the seat count of the newly reserved trip
                              };
                              relatedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialEntryForRelated);

                              // Find element to remove from matched_trips (requires exact match)
                              const matchedToRemove = (relatedTripData.matched_trips || []).find(m => m.trip_ref.path === newlyReservedTripPath);
                              if (matchedToRemove) {
                                  relatedTripUpdate.matched_trips = FieldValue.arrayRemove(matchedToRemove);
                                  logger.info(`-- Queued removal of ${newlyReservedTripPath} from ${relatedPath}'s matched_trips.`);
                              } else {
                                  logger.warn(`-- Could not find exact match for ${newlyReservedTripPath} in ${relatedPath}'s matched_trips to remove.`);
                              }


                              // n24: Update Newly Reserved Trip: Update mutual in its array entry for the related trip
                              const currentRelatedMatched = [...(currentNewlyReservedData.matched_trips || [])];
                              const currentRelatedPotential = [...(currentNewlyReservedData.potential_trips || [])];
                              let updatedNewlyReservedArrays = false;

                              const idxM = findTripIndex(currentRelatedMatched, relatedTripRef);
                              if (idxM !== -1) {
                                  updateNestedTripField(newlyReservedTripUpdate, 'matched_trips', idxM, 'mutual', !originalMutual);
                                  updatedNewlyReservedArrays = true;
                                  logger.info(`-- Updated mutual for ${relatedPath} in ${newlyReservedTripPath}'s matched_trips.`);
                              } else {
                                  const idxP = findTripIndex(currentRelatedPotential, relatedTripRef);
                                  if (idxP !== -1) {
                                     updateNestedTripField(newlyReservedTripUpdate, 'potential_trips', idxP, 'mutual', !originalMutual);
                                     updatedNewlyReservedArrays = true;
                                     logger.info(`-- Updated mutual for ${relatedPath} in ${newlyReservedTripPath}'s potential_trips.`);
                                  } else {
                                      logger.warn(`-- Could not find ${relatedPath} in ${newlyReservedTripPath}'s arrays to update mutual.`);
                                  }
                              }
                              // Apply array updates only if changes were made
                              if (!updatedNewlyReservedArrays) newlyReservedTripUpdate = {};


                              // n25/n26: Update Related Trip status if it became unmatched
                              const relatedWasOnlyMatchedWithNewlyReserved = (relatedTripData.matched_trips || []).length === 1 && (relatedTripData.matched_trips || [])[0].trip_ref.path === newlyReservedTripPath;
                              if (relatedWasOnlyMatchedWithNewlyReserved) {
                                  relatedTripUpdate.status = "unmatched";
                                  logger.info(`-- Setting related trip ${relatedPath} status to unmatched.`);
                              }

                         } else if (isGroup2) {
                             // n28: Update Related Trip: Update reserving_trip_obstruction in potential entry
                             logger.info(`Applying Group 2 (n28) logic to ${relatedPath}.`);
                             const currentPotentialForRelated = [...(relatedTripData.potential_trips || [])];
                             const idxP = findTripIndex(currentPotentialForRelated, newlyReservedTripRef);
                             if (idxP !== -1) {
                                 updateNestedTripField(newlyReservedTripUpdate, 'potential_trips', idxP, 'reserving_trip_obstruction', true); // Update in newly reserved trip as well
                                 logger.info(`-- Set reserving_trip_obstruction=true for ${newlyReservedTripPath} in ${relatedPath}'s potential_trips.`);
                             } else {
                                 logger.warn(`-- Could not find ${newlyReservedTripPath} in ${relatedPath}'s potential_trips to update obstruction.`);
                                 // It might have been in matched - needs moving similar to Group 1 but without mutual flip? Graph is unclear.
                                 // Safest is to just log if not found in potential.
                             }
                              // n27/n28 don't require updates on the newlyReservedTrip side.

                         } else {
                             logger.warn(`Related trip ${relatedPath} did not fall into Group 1 or Group 2 logic based on type='${originalType}', mutual='${originalMutual}'. Skipping cascade for this trip.`);
                         }

                         // Apply updates within transaction
                         if (Object.keys(relatedTripUpdate).length > 0) {
                             transaction.update(relatedTripRef, relatedTripUpdate);
                         }
                         if (Object.keys(newlyReservedTripUpdate).length > 0) {
                              // Only update if there are changes *and* we haven't already modified this doc in this loop instance
                              // (Ideally refetch fresh data each time if looping multiple related trips in ONE transaction, but we use separate transactions here)
                             transaction.update(newlyReservedTripRef, newlyReservedTripUpdate);
                         }

                     } else {
                         logger.info(`Related trip ${relatedPath} DOES proper match new reserver ${reservingTripPath}. No cascade needed for this trip.`);
                     }

                 }); // End Transaction for one related trip
             } // End loop through related trips

        } catch (error) {
            logger.error(`Error processing handleReservationCascade for ${newlyReservedTripPath}:`, error);
            // Throwing the error will cause Cloud Tasks to retry based on retryConfig
            throw error;
        }
    }
);

// --- END handleReservationCascade Cloud Function ---