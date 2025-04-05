import {ArrayFieldToDetails, Trip, PotentialTrip, MatchedTrip, TripGroupMember} from '../../../type';
import * as logger from "firebase-functions/logger";
import { DocumentReference, Transaction } from 'firebase-admin/firestore';



// --- Constants ---
const REQUIRED_OVERLAP = 150; // Meters


// --- Helper Functions ---

export function updateNestedTripField<K extends keyof ArrayFieldToDetails, T extends keyof ArrayFieldToDetails[K]>(
  updateObj: Record<string, any>,
  arrayField: K,
  index: number,
  fieldToUpdate: T,
  newValue: ArrayFieldToDetails[K][T]
): void {
  if (index === -1) {
    console.warn(`Index ${index} not found in ${arrayField}.`);
    return;
  }
  
  updateObj[`${arrayField}.${index}.${String(fieldToUpdate)}`] = newValue;
}

// --- Matching Logic Functions ---

/**
 * Variation 1: Checks if two trips "properly match" based on geometric conditions.
 * Can use pre-calculated distances if provided.
 *
 * @param trip1 - The first trip object.
 * @param trip2 - The second trip object.
 * @param pd - Optional: Pre-calculated pickup distance between trip1 and trip2.
 * @param dd - Optional: Pre-calculated destination distance between trip1 and trip2.
 * @returns True if the trips proper match geometrically, false otherwise.
 */
export function properMatchGeometric(
  trip1: Trip,
  trip2: Trip,
  pd: number,
  dd: number
): boolean {
  if (!trip1 || !trip2) {
    return false;
  }

  const p1 = trip1.pickup_radius;
  const p2 = trip2.pickup_radius;
  const d1 = trip1.destination_radius;
  const d2 = trip2.destination_radius;

  // Use provided distances if available, otherwise calculate them
  const pickupDistance = pd;
  const destinationDistance = dd;

  // Step 1 Check (Primary condition)
  const meetsStep1Condition =
    (p1 + p2) >= (pickupDistance + REQUIRED_OVERLAP) &&
    (d1 + d2) >= (destinationDistance + REQUIRED_OVERLAP);

  // Optional Step 4 Confirmation (can be redundant if Step 1 is sufficient, but included for completeness)
  const pickupOverlap = (p1 + p2) - pd;
  const destinationOverlap = (d1 + d2) - dd;
  const meetsStep4Condition = pickupOverlap >= REQUIRED_OVERLAP && destinationOverlap >= REQUIRED_OVERLAP;
  return meetsStep1Condition && meetsStep4Condition;
}

/**
 * Variation 2: Checks if two trips "properly match" by looking at their respective arrays.
 * (Remains the same as it doesn't use geometric distance directly)
 */
export function properMatchArrayCheck(trip1: Trip, trip2: Trip): boolean {
  // ... (Implementation remains the same)
  if (!trip1 || !trip2) {
    return false;
  }
  const trip1SeesTrip2AsMatch =
    (trip1.matched_trips?.some(mt => mt.trip_ref.id === trip2.trip_id)) ||
    (trip1.potential_trips?.some(pt => pt.trip_ref.id === trip2.trip_id && pt.proper_match));
  const trip2SeesTrip1AsMatch =
    (trip2.matched_trips?.some(mt => mt.trip_ref.id === trip1.trip_id)) ||
    (trip2.potential_trips?.some(pt => pt.trip_ref.id === trip1.trip_id && pt.proper_match));
  return trip1SeesTrip2AsMatch && trip2SeesTrip1AsMatch;
}


/**
 * Calculates the overlap gap required for two trips to meet the minimum overlap distance.
 * Returns 0 if the trips already meet or exceed the required overlap.
 * Can use a pre-calculated distance if provided.
 *
 * @param trip1 - The first trip object.
 * @param trip2 - The second trip object.
 * @param type - Specifies whether to calculate the 'pickup' or 'destination' gap.
 * @param precalculatedDistance - Optional: The pre-calculated distance (pickup or destination) between the trips.
 * @returns The calculated `gap` (additional radius needed).
 */
export function calculateGap(
  trip1: Trip,
  trip2: Trip,
  type: 'pickup' | 'destination',
  precalculatedDistance?: number // Added optional parameter
): number | null {
  if (!trip1 || !trip2) {
      throw new Error("Cannot calculate gap for null or undefined trips.");
  }
  if (!precalculatedDistance) {
    logger.warn(`Stored distance data not found between trip ${trip1.trip_id} and potential member ${trip2.trip_id}. Marking obstruction as unknown.`);
    return null;
  }

  let r1: number, r2: number, distance: number;

  if (type === 'pickup') {
    r1 = trip1.pickup_radius;
    r2 = trip2.pickup_radius;
    // Use provided distance if available, otherwise calculate
    distance = precalculatedDistance
  } else if (type === 'destination') {
    r1 = trip1.destination_radius;
    r2 = trip2.destination_radius;
    // Use provided distance if available, otherwise calculate
    distance = precalculatedDistance
  } else {
    throw new Error(`Invalid type provided to calculateGap: ${type}. Must be 'pickup' or 'destination'.`);
  }

  // Calculate gap based on Step 2: G = max(0, (D + O) - (R1 + R2))
  const gap = Math.max(0, (distance + REQUIRED_OVERLAP) - (r1 + r2));

  return gap;
}

export function getStoredDistances(
    primaryTrip: Trip,
    secondaryTripRef: DocumentReference
  ): {pickupDistance: number; destinationDistance: number;} | null {
  
    if (!primaryTrip || !secondaryTripRef) {
      logger.warn("getStoredDistances: Received null trip or reference.");
      return null;
    }
  
    const secondaryTripId = secondaryTripRef.id;
  
    // 1. Search matched_trips first
    if (primaryTrip.matched_trips && primaryTrip.matched_trips.length > 0) {
      const matchedRelation = primaryTrip.matched_trips.find(
        (mt: MatchedTrip) => mt.trip_ref?.id === secondaryTripId // Add optional chaining for safety
      );
  
      if (matchedRelation) {
        // Found in matched_trips
        if (matchedRelation.pickup_distance !== undefined && matchedRelation.destination_distance !== undefined) {
           return {
             pickupDistance: matchedRelation.pickup_distance,
             destinationDistance: matchedRelation.destination_distance,
           };
        } else {
            logger.warn(`getStoredDistances: Found matched relation for ${secondaryTripId} in trip ${primaryTrip.trip_id}, but distances are missing.`);
            // Decide how to handle missing distances - perhaps return null or throw error?
            // Returning null for now to indicate data issue.
            return null;
        }
      }
    }
  
    // 2. If not found, search potential_trips
    if (primaryTrip.potential_trips && primaryTrip.potential_trips.length > 0) {
      const potentialRelation = primaryTrip.potential_trips.find(
        (pt: PotentialTrip) => pt.trip_ref?.id === secondaryTripId // Add optional chaining
      );
  
      if (potentialRelation) {
        // Found in potential_trips
         if (potentialRelation.pickup_distance !== undefined && potentialRelation.destination_distance !== undefined) {
           return {
             pickupDistance: potentialRelation.pickup_distance,
             destinationDistance: potentialRelation.destination_distance,
           };
        } else {
            logger.warn(`getStoredDistances: Found potential relation for ${secondaryTripId} in trip ${primaryTrip.trip_id}, but distances are missing.`);
            return null; // Indicate data issue
        }
      }
    }
  
    // 3. Not found in either array
    logger.info(`getStoredDistances: No stored relationship found for ${secondaryTripId} in trip ${primaryTrip.trip_id}.`);
    return null;
  }


  export async function checkAnyMemberUnknownToTrip(
    potentialTripRef: DocumentReference,
    tripGroupMembers: TripGroupMember[],
    transaction: Transaction
  ): Promise<boolean> {
    if (!potentialTripRef) {
      logger.error("checkAnyMemberUnknownToTrip: potentialTripRef is required.");
      return true; // Treat as unknown if the reference itself is missing
    }
    if (!tripGroupMembers || tripGroupMembers.length === 0) {
      // If there are no members, none can be unknown.
      return false;
    }
  
    let potentialTrip: Trip | null = null;
  
    try {
      // Fetch the potentialTrip's document first
      const potentialTripDoc = await transaction.get(potentialTripRef);
      if (!potentialTripDoc.exists) {
        logger.warn(`checkAnyMemberUnknownToTrip: Potential trip document ${potentialTripRef.id} not found.`);
        // If the potential trip doesn't exist, we can't know its relationships.
        // Treat this situation as having an unknown member for safety.
        return true;
      }
      potentialTrip = potentialTripDoc.data() as Trip;
  
    } catch (error) {
      logger.error(`checkAnyMemberUnknownToTrip: Error fetching potential trip ${potentialTripRef.id}`, error);
      // If we fail to fetch the potential trip, assume unknown members for safety.
      return true;
    }
  
    // Now iterate through the group members and check against the fetched potentialTrip
    for (const member of tripGroupMembers) {
      if (!member || !member.trip_ref) {
        logger.warn("checkAnyMemberUnknownToTrip: Skipping invalid group member data.");
        continue; // Skip potentially corrupt member data
      }
  
      const memberTripId = member.trip_ref.id;
  
      // Don't check a trip against itself
      if (potentialTripRef.id === memberTripId) {
        continue;
      }
  
      // Check if memberTripId is in potentialTrip's matched_trips
      const isInMatched = potentialTrip.matched_trips?.some(
        (mt) => mt.trip_ref?.id === memberTripId
      ) ?? false;
  
      // Check if memberTripId is in potentialTrip's potential_trips
      const isInPotential = potentialTrip.potential_trips?.some(
        (pt) => pt.trip_ref?.id === memberTripId
      ) ?? false;
  
      // If this member is NOT in EITHER array of the potentialTrip, then return true
      if (!isInMatched && !isInPotential) {
        logger.info(`checkAnyMemberUnknownToTrip: Member ${memberTripId} is unknown to potential trip ${potentialTripRef.id}.`);
        return true; // Found an unknown member, no need to check further
      }
    }
  
    // If the loop completes without returning true, all members were found
    // in either matched or potential for the potentialTrip.
    return false;
  }