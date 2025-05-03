import * as logger from "firebase-functions/logger";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { DocumentReference } from "firebase-admin/firestore";
import { Trip, PotentialTrip} from "../../../type";
import { findTripIndex, updateNestedTripField } from '../utils/utils';
import { db } from "../firebaseAdmin";


// --- Cloud Function: handlePotentialPaidUnmatchCascade ---

interface PotentialCascadePayload {
    formerReservingTripPath: string;
}

// Corrected Options structure:
const potentialTaskHandlerOptions = {
    retryConfig: {
        maxAttempts: 5,
        minBackoffSeconds: 10,
    },
    rateLimits: {
        maxConcurrentDispatches: 10, // Adjust as needed
    },
    // region: "us-central1", // Specify other options if needed
};


export const handlePotentialPaidUnmatchCascade = onTaskDispatched<PotentialCascadePayload>(
    potentialTaskHandlerOptions,
    async (request) => {
        const { formerReservingTripPath } = request.data;
        logger.info(`handlePotentialPaidUnmatchCascade triggered for formerReserver: ${formerReservingTripPath}`);

        if (!formerReservingTripPath) {
            logger.error("Missing formerReservingTripPath in payload.");
            return; // Acknowledge task
        }

        const formerReservingTripRef = db.doc(formerReservingTripPath) as DocumentReference<Trip>;

        try {
            // 1. Fetch the trip that became unmatched (formerReservingTrip)
            const formerReservingTripSnap = await formerReservingTripRef.get();
            if (!formerReservingTripSnap.exists) {
                logger.error(`Former reserving trip ${formerReservingTripPath} not found. Cannot process cascade.`);
                return; // Acknowledge task
            }
            const formerReservingTripData = formerReservingTripSnap.data() as Trip;

            // 2. Get its potential_trips array
            const potentialTripsOnFormer = formerReservingTripData.potential_trips || [];
            if (potentialTripsOnFormer.length === 0) {
                logger.info(`Former reserving trip ${formerReservingTripPath} has no potential trips. No cascade needed.`);
                return;
            }

            // 3. Filter for trips where mutual is true
            const potentialMutualTrips = potentialTripsOnFormer.filter(pt => pt.mutual === true);
            if (potentialMutualTrips.length === 0) {
                logger.info(`Former reserving trip ${formerReservingTripPath} has no potential trips with mutual=true. No cascade needed.`);
                return;
            }

            logger.info(`Found ${potentialMutualTrips.length} potential mutual trips to check for n18 cascade on former reserver ${formerReservingTripPath}.`);

            const updates: Promise<void>[] = [];

            // 4. Iterate through the filtered mutual trips
            for (const mutualPotential of potentialMutualTrips) {
                const relatedTripRef = mutualPotential.trip_ref;
                if (!relatedTripRef) {
                    logger.warn("Found potential entry with mutual=true but missing trip_ref. Skipping.", mutualPotential);
                    continue;
                }

                // Process each related trip in its own transaction
                const updatePromise = db.runTransaction(async (transaction) => {
                    const targetTripSnap = await transaction.get(relatedTripRef as DocumentReference<Trip>); // Fetch related trip

                    if (!targetTripSnap.exists) {
                        logger.warn(`Target trip ${relatedTripRef.path} (found via former reserver's potential) not found during transaction. Skipping.`);
                        return;
                    }
                    const targetTripData = targetTripSnap.data() as Trip;
                    const potentialTripsOnTarget = [...(targetTripData.potential_trips || [])];
                    
                    // Find the element representing the formerReservingTrip in the target's potential list
                    const indexToUpdate = findTripIndex(potentialTripsOnTarget, formerReservingTripRef);
                    
                    if (indexToUpdate !== -1) {
                        const potentialElement = potentialTripsOnTarget[indexToUpdate];

                        // *** Crucial Check: Only update if it was marked as paid ***
                        if (potentialElement.paid === true) {
                            const potentialElementUpdate: Record<string, any> = {};
                            logger.info(`Updating paid potential entry for ${formerReservingTripPath} in trip ${relatedTripRef.path}.`);
                            
                            // Apply n18 updates to the element using updateNestedTripField
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "paid", false);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "trip_group_ref", null);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "trip_obstruction", false);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "group_largest_pickup_overlap_gap", null);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "group_largest_destination_overlap_gap", null);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "total_seat_count", null);
                            updateNestedTripField(potentialElementUpdate, "potential_trips", indexToUpdate, "seat_obstruction", false);

                            // Overwrite the array in the transaction update
                            transaction.update(relatedTripRef, potentialElementUpdate);

                            // Overwrite the array in the transaction update
                            transaction.update(relatedTripRef, { potential_trips: potentialTripsOnTarget });
                        } else {
                             logger.info(`Skipping update for ${formerReservingTripPath} in trip ${relatedTripRef.path}, potential entry was not marked as paid.`);
                        }
                    } else {
                        // Log if the former reserver wasn't found in the target's potential list
                        logger.warn(`Former reserver ${formerReservingTripPath} not found in potential_trips array of ${relatedTripRef.path} within transaction, though expected from mutual link.`);
                    }
                }).catch(error => {
                    // Log transaction errors for individual trips but don't stop processing others
                    logger.error(`Transaction failed for updating trip ${relatedTripRef.path} for n18 cascade:`, error);
                });
                 updates.push(updatePromise); // Add transaction promise to array
            } // End loop

            // 5. Wait for all individual transaction promises to settle
            await Promise.allSettled(updates);
            logger.info(`Finished processing potential n18 cascade for ${formerReservingTripPath}.`);

        } catch (error) {
            logger.error(`Error processing handlePotentialPaidUnmatchCascade for ${formerReservingTripPath}:`, error);
            // Throw error to trigger Cloud Tasks retry
            throw error;
        }
    }
);

// --- END handlePotentialPaidUnmatchCascade Cloud Function ---