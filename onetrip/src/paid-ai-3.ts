import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { DocumentReference, FieldValue, Timestamp, getFirestore, Transaction} from "firebase-admin/firestore";
import { Trip, User, TripGroup, MatchedTrip, PotentialTrip, Message, LatLng, TripGroupInfo, PotentialTripMember, TripGroupMember, PickupLocationSuggestion, DestinationSuggestion} from "../../type";
import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { updateNestedTripField, properMatchArrayCheck, getStoredDistances, calculateGap, checkAnyMemberUnknownToTrip } from './utils/utils'; // Import helper functions

//Assuming the use of these APIs
interface MapsNearbySearchResult {
    places: {
        displayName: { text: string };
        formattedAddress: string;
        location: { latitude: number; longitude: number };
    }[];
}
  
  interface DistanceMatrixResult {
    rows: {
        elements: {
            distance: { value: number }; // Distance in meters
            duration: { value: number }; // Duration in seconds
            status: string;
        }[];
    }[];
}

const MAX_RADIUS = 5000;

export const tripPaid = onDocumentUpdated("users/{userId}/trips/{tripId}", async (event) => {
  
    try {
    // Ensure the event is valid and contains the necessary data.
    if (!event.data) {
      throw new HttpsError("failed-precondition", "No trip data found in the event.");
    }
    const previousTripData = event.data.before.data() as Trip;
    const currentTripData = event.data.after.data() as Trip;

    // Check if the status has actually changed to 'paid'.
    if (!(previousTripData.status !== 'paid' && currentTripData.status === 'paid')) {
       logger.info("Trip status is not updated to paid. Exiting the function", { tripId: currentTripData.trip_id });
       return; // Exit if the status didn't change to 'paid'
    }
    
    //NPT is the New Paid Trip
    const nptTripRef = event.data.after.ref; 
    const db = getFirestore();

    await db.runTransaction(async (transaction: Transaction) => {

        const nptTrip = (await transaction.get(nptTripRef)).data() as Trip;

        if (!nptTrip) {
            throw new HttpsError("not-found", `NPT Trip with ID ${nptTripRef.id} not found.`);
        }

        //check to make sure this logic will run only once
        if (nptTrip.status != 'paid') {
          return;
        }


      let choiceTripGroupRef: DocumentReference;
      let choiceTripGroup: TripGroup | undefined;

      // --- Step 2: Check if NPT is reserved ---
      if (nptTrip.reserved) { //n2
        logger.info("NPT is reserved", { tripId: nptTrip.trip_id });
        const reservingTripRef = nptTrip.reserving_trip_ref;
        if (!reservingTripRef) {
          throw new HttpsError("failed-precondition", "NPT is reserved but has no reserving_trip_ref");
        }

        const reservingTrip = (await transaction.get(reservingTripRef)).data() as Trip;
        if (!reservingTrip) {
          throw new HttpsError("not-found", `Reserving trip with ID ${reservingTripRef.id} not found.`);
        }

        choiceTripGroupRef = reservingTrip.trip_group_ref;  //n3
        choiceTripGroup = (await transaction.get(choiceTripGroupRef)).data() as TripGroup;

          if (!choiceTripGroup) {
              throw new HttpsError("not-found", `Choice Trip Group with ID ${choiceTripGroupRef.id} not found.`);
          }
        //n4 Update NPT document
        const nptUpdateData: Partial<Trip> = { //n4
          trip_group_ref: choiceTripGroupRef,
          total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
          reserved: false,
        };
        // Conditionally delete the reserving_trip_ref field using FieldValue.delete()
        nptUpdateData.reserving_trip_ref = FieldValue.delete() as any; // Cast to any because of type conflict

        transaction.update(nptTripRef, nptUpdateData);

        // Update NPT's reserving trip (n5)
        const reservingTripUpdate: Record<string, any> = {
          total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
        };

        const matchedTripIndex = reservingTrip.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
        if (matchedTripIndex === -1) {
          throw new HttpsError("failed-precondition", "NPT not found in reserving trip's matched_trips.");
        }

        updateNestedTripField(reservingTripUpdate, 'matched_trips', matchedTripIndex, 'seat_count', nptTrip.seat_count);
        updateNestedTripField(reservingTripUpdate, 'matched_trips', matchedTripIndex, 'paid', true);
        updateNestedTripField(reservingTripUpdate, 'matched_trips', matchedTripIndex, 'trip_group_ref', choiceTripGroupRef);
        updateNestedTripField(reservingTripUpdate, 'matched_trips', matchedTripIndex, 'reserving', false);


        transaction.update(reservingTripRef, reservingTripUpdate);
      } else {
          // --- Steps 6-14: Find Choice Trip Group ---
          logger.info("NPT is not reserved", { tripId: nptTrip.trip_id });
          const matchedTrips = nptTrip.matched_trips; //n6
          const paidMatchedTrips = nptTrip.matched_trips.filter((mt) => mt.paid);

          // Check if matchedTrips is defined and not empty
          if (!matchedTrips || matchedTrips.length === 0 || paidMatchedTrips.length < 1) {

              //n56
              logger.info("Creating new Trip Group as Choice Trip Group");
              const newTripGroupRef = db.collection('trip_groups').doc();
              choiceTripGroupRef = newTripGroupRef;
              //Create the new Trip Group
              const newTripGroup: TripGroup = { //n57
                  trip_group_members: [{
                      trip_ref: nptTripRef,
                      user_ref: nptTripRef.parent.parent!,
                      first_name: (await nptTripRef.parent.parent!.get()).data()?.first_name, // Get user data properly
                      last_name: (await nptTripRef.parent.parent!.get()).data()?.last_name,
                      phone_number: (await nptTripRef.parent.parent!.get()).data()?.phone_number,
                      photo_url: (await nptTripRef.parent.parent!.get()).data()?.photo_url,
                      seat_count: nptTrip.seat_count,
                      joined_timestamp: Timestamp.now(),
                      last_message_read_id: "",
                      time_range_array: nptTrip.time_range_array,
                      arrived: false,
                      trip_group_leader: true, // First member is the leader
                      canceled: false,

                  }],
                  recent_message: null,
                  total_seat_count: nptTrip.seat_count,
                  potential_trip_members: [], // Initialize as empty
                  pickup_location_suggestions: [],
                  destination_suggestions: [],
              };


              // Add all of NPT's matched and potential trips to potential_trip_members
              const allRelatedTrips = [...nptTrip.matched_trips, ...nptTrip.potential_trips]; //n57

              for (const relatedTrip of allRelatedTrips) {
                const relatedTripData = (await transaction.get(relatedTrip.trip_ref)).data() as Trip;

                if(!relatedTripData){
                  logger.warn(`Related trip data is null for trip ID: ${relatedTrip.trip_ref.id}, skipping...`);
                  continue;
                }

                const tripObstruction = !properMatchArrayCheck(nptTrip, relatedTripData);

                const distance = getStoredDistances(nptTrip,relatedTrip.trip_ref);

                const potentialTripMember: PotentialTripMember = {
                    trip_ref: relatedTrip.trip_ref,
                    obstructing_trip_members: tripObstruction ? [{
                        trip_ref: nptTripRef,
                        pickup_overlap_gap: calculateGap(nptTrip, relatedTripData, 'pickup', distance?.pickupDistance),
                        destination_overlap_gap: calculateGap(nptTrip, relatedTripData, 'destination', distance?.destinationDistance),
                        unknown: distance ? false : true,
                    }] : [],
                    trip_obstruction: tripObstruction,
                    seat_obstruction: false, // Initially false
                    seat_count: relatedTrip.seat_count,
                    unknown_trip_obstruction: distance ? false : true,
                };

                newTripGroup.potential_trip_members.push(potentialTripMember);
              }

              transaction.set(newTripGroupRef, newTripGroup);

              //n58
              const nptUpdate: Partial<Trip> = {
                trip_group_ref: newTripGroupRef,
                total_seat_count: nptTrip.seat_count,
              };
              transaction.update(nptTripRef, nptUpdate);

              //n59
              const matchedTripsMutualTrue = nptTrip.matched_trips.filter(mt => mt.mutual);
              const potentialTripsMutualFalse = nptTrip.potential_trips.filter(pt => !pt.mutual);
              //n60
              const tripsToUpdate = [...matchedTripsMutualTrue, ...potentialTripsMutualFalse];

              for (const trip of tripsToUpdate) {
                const tripUpdate: Record<string, any> = {};

                const matchedTripIndex = ((await transaction.get(trip.trip_ref)).data() as Trip)?.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);

                if (matchedTripIndex != -1) {
                  updateNestedTripField(tripUpdate, 'matched_trips', matchedTripIndex, 'paid', true);
                  updateNestedTripField(tripUpdate, 'matched_trips', matchedTripIndex, 'trip_group_ref', newTripGroupRef);
                }

                transaction.update(trip.trip_ref, tripUpdate);
              }
              //n61
              const matchedTripsMutualFalse = nptTrip.matched_trips.filter(mt => !mt.mutual);
              const potentialTripsMutualTrue = nptTrip.potential_trips.filter(pt => pt.mutual);

              const tripGroupInfos: TripGroupInfo[] = [];

              const tripsToProcess = [...matchedTripsMutualFalse, ...potentialTripsMutualTrue]; // Combine both arrays

              for (const trip of tripsToProcess) { // Unified loop for both matched and potential trips
                const tripData = (await transaction.get(trip.trip_ref)).data() as Trip;
                const tripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === nptTrip.trip_id);

                if (!tripData) {
                  throw new HttpsError("not-found", `Trip data is null for trip ID: ${trip.trip_ref.id}, skipping...`);
                }

                const distance = getStoredDistances(nptTrip, trip.trip_ref);

                const pickupGap = calculateGap(nptTrip, tripData, 'pickup', distance?.pickupDistance);
                const destinationGap = calculateGap(nptTrip, tripData, 'destination', distance?.destinationDistance);

                tripGroupInfos.push({
                  tripGroupId: tripData.trip_group_ref.id,
                  tripObstruction: true,
                  seatObstruction: false,
                  largestPickupOverlapGap: tripData.potential_trips[tripIndex].proper_match ? null : pickupGap,
                  largestDestinationOverlapGap: tripData.potential_trips[tripIndex].proper_match ? null : destinationGap,
                });

                const tripUpdate: Record<string, any> = {};
                if (tripIndex !== -1) {
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'paid', true);
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'trip_group_ref', newTripGroupRef);
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'trip_obstruction', true);
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'group_largest_pickup_overlap_gap', pickupGap);
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'group_largest_destination_overlap_gap', destinationGap);
                  updateNestedTripField(tripUpdate, 'potential_trips', tripIndex, 'total_seat_count', nptTrip.seat_count);
                }

                transaction.update(trip.trip_ref, tripUpdate);
              }

              //n63 get matched trip that's the nearest combined distances from NPT
              let nearestTrip: MatchedTrip | null = null;
              let minDistance = Infinity;
              for(const matchedTrip of nptTrip.matched_trips){
                const totalDistance = matchedTrip.pickup_distance + matchedTrip.destination_distance;
                if(totalDistance < minDistance){
                  minDistance = totalDistance;
                  nearestTrip = matchedTrip;
                }
              }
              //n64
              if(nearestTrip){
                const tripsWithSameDistance = nptTrip.matched_trips.filter(mt => mt.pickup_distance + mt.destination_distance === nearestTrip!.pickup_distance + nearestTrip!.destination_distance);

                let tripToReserve: MatchedTrip;
                //n65
                if(tripsWithSameDistance.length > 1){
                  const randomIndex = Math.floor(Math.random() * tripsWithSameDistance.length);
                  tripToReserve = tripsWithSameDistance[randomIndex];
                } else {
                  tripToReserve = nearestTrip;
                }

                //n66
                const tripToReserveRef = tripToReserve.trip_ref;
                transaction.update(tripToReserveRef, {
                  reserved: true,
                  reserving_trip_ref: nptTripRef,
                });
                //n67
                const nptMatchedTripIndex = nptTrip.matched_trips.findIndex(mt => mt.trip_ref.id === tripToReserveRef.id);
                if(nptMatchedTripIndex != -1){
                    transaction.update(nptTripRef, {
                      [`matched_trips.${nptMatchedTripIndex}.reserving`]: true,
                    });
                }

                //n68
                  //Get all the Newly Reserved Trip’s (matched trips with mutual as true and potential trips with mutual and false) that do not proper match the NPT
                const newlyReservedTrip = (await transaction.get(tripToReserveRef)).data() as Trip;
                if(!newlyReservedTrip){
                  throw new HttpsError('not-found', "newly reserved trip not found")
                }
                const newlyReservedTripMatchedTripsMutualTrue = newlyReservedTrip.matched_trips.filter(mt => mt.mutual);
                const newlyReservedTripPotentialTripsMutualFalse = newlyReservedTrip.potential_trips.filter(pt => !pt.mutual);

                const tripsToProcess = [
                  ...newlyReservedTripMatchedTripsMutualTrue,
                  ...newlyReservedTripPotentialTripsMutualFalse,
                ];

                for (const trip of tripsToProcess) { // Combined loop for matched and potential trips
                  const tripData = (await transaction.get(trip.trip_ref)).data() as Trip;
                  if (!tripData) {
                  throw new HttpsError("not-found", `Trip data is null for trip ID: ${trip.trip_ref.id}, skipping...`);
                  }

                  if (!properMatchArrayCheck(nptTrip, tripData)) { // Check if they do not proper match
                  const tripUpdate: Partial<Trip> = {};

                  const matchedTripIndex = tripData.matched_trips.findIndex(mt => mt.trip_ref.id === newlyReservedTrip.trip_id);
                  if (matchedTripIndex !== -1) { // Delete newly reserved trip from their matched trips
                    tripUpdate.matched_trips = FieldValue.arrayRemove(tripData.matched_trips[matchedTripIndex]) as any;
                  }

                  const potentialTripToBeAdded: PotentialTrip = { // Add newly reserved trip to their potential trips
                    trip_ref: tripToReserveRef,
                    paid: false,
                    trip_group_ref: null, // n69 ***
                    pickup_radius: tripData.matched_trips[matchedTripIndex].pickup_radius,
                    destination_radius: tripData.matched_trips[matchedTripIndex].destination_radius,
                    pickup_distance: tripData.matched_trips[matchedTripIndex].pickup_distance,
                    destination_distance: tripData.matched_trips[matchedTripIndex].destination_distance,
                    proper_match: true,
                    trip_obstruction: false,
                    seat_obstruction: false,
                    reserving_trip_obstruction: true,
                    mutual: !trip.mutual, // n69
                    group_largest_pickup_overlap_gap: null,
                    group_largest_destination_overlap_gap: null,
                    unknown_trip_obstruction: false,
                    total_seat_count: null,
                    seat_count: newlyReservedTrip.seat_count,
                  };

                  tripUpdate.potential_trips = FieldValue.arrayUnion(potentialTripToBeAdded) as any;
                  tripUpdate.status = tripData.matched_trips.length === 1 ? "unmatched" : tripData.status; // Update status if only one matched trip

                  transaction.update(trip.trip_ref, tripUpdate);

                  // n70
                  const newlyReservedTripUpdate: Partial<Trip> = {};
                  const newlyReservedTripMatchedTripIndex = newlyReservedTrip.matched_trips.findIndex(mt => mt.trip_ref.id === trip.trip_ref.id);
                  const newlyReservedTripPotentialTripIndex = newlyReservedTrip.potential_trips.findIndex(pt => pt.trip_ref.id === trip.trip_ref.id);

                  if (newlyReservedTripMatchedTripIndex !== -1) {
                    updateNestedTripField(
                      newlyReservedTripUpdate,
                      'matched_trips',
                      newlyReservedTripMatchedTripIndex,
                      'mutual',
                      !newlyReservedTrip.matched_trips[newlyReservedTripMatchedTripIndex].mutual
                    );
                  }

                  if (newlyReservedTripPotentialTripIndex !== -1) {
                    updateNestedTripField(
                      newlyReservedTripUpdate,
                      'potential_trips',
                      newlyReservedTripPotentialTripIndex,
                      'mutual',
                      !newlyReservedTrip.potential_trips[newlyReservedTripPotentialTripIndex].mutual
                    );
                  }

                  transaction.update(tripToReserveRef, newlyReservedTripUpdate);
                  }
                }
                  
                //n73
                //matched trips with mutual as false and potential trips with mutual and true
                const newlyReservedTripMatchedTripsMutualFalse = newlyReservedTrip.matched_trips.filter(mt => !mt.mutual);
                const newlyReservedTripPotentialTripsMutualTrue = newlyReservedTrip.potential_trips.filter(pt => pt.mutual);

                const tripsToProcess2 = [
                  ...newlyReservedTripMatchedTripsMutualFalse,
                  ...newlyReservedTripPotentialTripsMutualTrue,
                ];

                for (const trip of tripsToProcess2) {
                  const tripData = (await transaction.get(trip.trip_ref)).data() as Trip;
                  if (!tripData) {
                  throw new HttpsError("not-found", `Trip data is null for trip ID: ${trip.trip_ref.id}, skipping...`);
                  }

                  if (!properMatchArrayCheck(nptTrip, tripData)) {
                  const tripUpdate: Partial<Trip> = {};
                  const potentialTripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === newlyReservedTrip.trip_id);
                  if (potentialTripIndex !== -1) {
                    updateNestedTripField(tripUpdate, 'potential_trips', potentialTripIndex, 'reserving_trip_obstruction', true);
                    transaction.update(trip.trip_ref, tripUpdate);
                  }
                  }
                }
              }
            //end of creating a new trip group
          }
          else{
            logger.info("Finding existing Trip Group to join...");
            const distinctTripGroupIds = new Set<string>(); //n7
            for (const matchedTrip of paidMatchedTrips) {
              if (matchedTrip.trip_group_ref) {
                distinctTripGroupIds.add(matchedTrip.trip_group_ref.id);
              }
            }

            if (distinctTripGroupIds.size > 1){ //n9
              const tripGroups = await Promise.all(
                  Array.from(distinctTripGroupIds).map(async (groupId) => {
                      const groupRef = db.collection('trip_groups').doc(groupId);
                      const groupDoc = await transaction.get(groupRef);
                      return { ref: groupRef, data: groupDoc.data() as TripGroup };
                  })
              );

              //n10 Find the trip group with the least number of trips.
              let minTripCount = Infinity;
              let smallestTripGroups: {ref: DocumentReference, data: TripGroup}[] = [];
              for (const tripGroup of tripGroups) {
                const tripCount = tripGroup.data.trip_group_members.length;
                if (tripCount < minTripCount) {
                  minTripCount = tripCount;
                  smallestTripGroups = [tripGroup];
                } else if (tripCount === minTripCount) {
                  smallestTripGroups.push(tripGroup);
                }
              }

                //n11 Are there more than one trip groups that have the least number of trips?
              if (smallestTripGroups.length > 1) { //n11

                //n12 Get the trip group that NPT that has the least: total pickup distance apart + total destination distance apart, from the members of that trip group
                let minTotalDistance = Infinity;
                let closestTripGroups: {ref: DocumentReference, data: TripGroup}[] = [];

                for (const tripGroup of smallestTripGroups) {
                    let totalDistance = 0;

                    // Iterate over each member of the trip group
                    for (const member of tripGroup.data.trip_group_members) {
                      const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                      if(!memberTrip){
                        logger.warn(`Member trip is null for ${member.trip_ref.id}`);
                        continue;
                      }
                        // Add the pickup and destination distances to the total
                        totalDistance += distanceBetween(nptTrip.pickup_latlng, memberTrip.pickup_latlng);
                        totalDistance += distanceBetween(nptTrip.destination_latlng, memberTrip.destination_latlng);
                    }
                    // Update the minimum distance and closest trip groups
                    if (totalDistance < minTotalDistance) {
                        minTotalDistance = totalDistance;
                        closestTripGroups = [tripGroup];
                    } else if (totalDistance === minTotalDistance) {
                        closestTripGroups.push(tripGroup);
                    }
                }

                  //n13 Are there more than one trip groups that have the least distance apart from pickup distance?
                if (closestTripGroups.length > 1) { //n13
                  // Randomly pick one of these trip groups (n14)
                  const randomIndex = Math.floor(Math.random() * closestTripGroups.length);
                  choiceTripGroupRef = closestTripGroups[randomIndex].ref;
                  choiceTripGroup = closestTripGroups[randomIndex].data;

                } else {
                  choiceTripGroupRef = closestTripGroups[0].ref;
                  choiceTripGroup = closestTripGroups[0].data;
                }
              } else {
                choiceTripGroupRef = smallestTripGroups[0].ref;
                choiceTripGroup = smallestTripGroups[0].data;
              }

              //n15 and part of n26
              const nptUpdate: Partial<Trip> = {
                trip_group_ref: choiceTripGroupRef,
                total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
              };
              transaction.update(nptTripRef, nptUpdate);
              
              //n16 Does choice TG have only 1 member?
              if (choiceTripGroup.trip_group_members.length === 1) { //n16

                //n17 In this sole trip group member’s trip document, from it’s matched trips field, get the trip that it’s reserving (look for the trip in which the reserving key is true)
                const soleTripGroupMemberTripRef = choiceTripGroup.trip_group_members[0].trip_ref;
                const soleTripGroupMemberTrip = (await transaction.get(soleTripGroupMemberTripRef)).data() as Trip;
                
                if(!soleTripGroupMemberTrip){
                  throw new HttpsError('not-found', 'sole trip group member trip not found')
                }

                const reservedTripBySoleMember = soleTripGroupMemberTrip.matched_trips.find(mt => mt.reserving);
                if(reservedTripBySoleMember){
                  const reservedTripBySoleMemberRef = reservedTripBySoleMember.trip_ref;
                  //n18
                  const soleTGMemberMatchedTripIndex = soleTripGroupMemberTrip.matched_trips.findIndex(mt => mt.trip_ref.id === reservedTripBySoleMemberRef.id);

                  if(soleTGMemberMatchedTripIndex != -1){
                    transaction.update(soleTripGroupMemberTripRef, {
                      [`matched_trips.${soleTGMemberMatchedTripIndex}.reserving`]: false,
                    });
                  }

                  //n19
                  transaction.update(reservedTripBySoleMemberRef, {
                    reserved: false,
                    reserving_trip_ref: FieldValue.delete(),
                  });

                  //n20
                  const tripThatSoleMemberWasReserving = (await transaction.get(reservedTripBySoleMemberRef)).data() as Trip;
                  if(!tripThatSoleMemberWasReserving){
                    throw new HttpsError('not-found', 'trip that sole member was reserving not found')
                  }
                  //n21
                  const tripsReservingTripObstructedAndProperMatchFalse: DocumentReference[] = [];
                  const tripsReservingTripObstructedAndProperMatchTrue: DocumentReference[] = [];


                  const matchedTripsMutualFalse = tripThatSoleMemberWasReserving.matched_trips.filter(mt => !mt.mutual);
                  const potentialTripsMutualTrue = tripThatSoleMemberWasReserving.potential_trips.filter(pt => pt.mutual);
                    
                  const tripsToProcess = [...matchedTripsMutualFalse, ...potentialTripsMutualTrue]; // Combine both arrays

                  for (const trip of tripsToProcess) { // Unified loop for both matched and potential trips
                    const tripData = (await transaction.get(trip.trip_ref)).data() as Trip;
                    if (!tripData) {
                      throw new HttpsError("not-found", `Trip data is null for trip ID: ${trip.trip_ref.id}, skipping...`);
                    }
                    const tripPotentialTripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === reservedTripBySoleMemberRef.id);

                    if (tripPotentialTripIndex !== -1) {
                      const potentialTrip = tripData.potential_trips[tripPotentialTripIndex];
                      if (potentialTrip.reserving_trip_obstruction && !potentialTrip.proper_match) {
                      tripsReservingTripObstructedAndProperMatchFalse.push(trip.trip_ref);
                      }
                      if (potentialTrip.reserving_trip_obstruction && potentialTrip.proper_match) {
                      tripsReservingTripObstructedAndProperMatchTrue.push(trip.trip_ref);
                      }
                    }
                  }
                  
                    //n22
                    //All the matched trips with mutual as false and potential trips with mutual as true of the trip that sole trip group member was reserving that were reserving trip obstructed and do not proper match
                  for(const tripRef of tripsReservingTripObstructedAndProperMatchFalse){ //n22
                    const tripData = (await transaction.get(tripRef)).data() as Trip;
                    if (!tripData) {
                      throw new HttpsError("not-found", `Trip data is null for trip ID: ${tripRef.id}, skipping...`);
                    }
                    const potentialTripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === reservedTripBySoleMemberRef.id);
                    if(potentialTripIndex != -1){
                      transaction.update(tripRef, {
                        [`potential_trips.${potentialTripIndex}.reserving_trip_obstruction`]: false,
                      });
                    }
                  }
                  const tripThatSoleMemberWasReservingUpdate: Partial<Trip> = {};
                  
                  for(const tripRef of tripsReservingTripObstructedAndProperMatchTrue){ //n23
                    const trip = (await transaction.get(tripRef)).data() as Trip;
                    if (!trip) {
                        throw new HttpsError("not-found", `Trip data is null for trip ID: ${tripRef.id}, skipping...`);
                    }
                      const tripUpdate: Partial<Trip> = {};
                      // In each of their potential trips fields delete the elements containing the trip that sole trip member was reserving
                      const potentialTripIndex = trip.potential_trips.findIndex(pt => pt.trip_ref.id === reservedTripBySoleMemberRef.id);
                      if(potentialTripIndex != -1){
                        tripUpdate.potential_trips = FieldValue.arrayRemove(trip.potential_trips[potentialTripIndex]) as any;
                      }

                      const matchedTripToBeAdded: MatchedTrip = {
                        trip_ref: reservedTripBySoleMemberRef,
                        trip_group_ref: null, //n23
                        paid: false,
                        pickup_radius: tripThatSoleMemberWasReserving.pickup_radius,
                        destination_radius: tripThatSoleMemberWasReserving.destination_radius,
                        pickup_distance: tripThatSoleMemberWasReserving.potential_trips[potentialTripIndex].pickup_distance,
                        destination_distance: tripThatSoleMemberWasReserving.potential_trips[potentialTripIndex].destination_distance,
                        mutual: tripThatSoleMemberWasReserving.matched_trips.some(mt => mt.trip_ref.id === tripRef.id), // Check if in matched_trips
                        reserving: false,
                        seat_count: tripThatSoleMemberWasReserving.seat_count
                      };

                      tripUpdate.matched_trips = FieldValue.arrayUnion(matchedTripToBeAdded) as any;

                      transaction.update(tripRef, tripUpdate);
                  }

                  //n24
                  
                  for(const matchedTrip of tripsReservingTripObstructedAndProperMatchTrue){ //matched
                    const matchedTripData = (await transaction.get(matchedTrip)).data() as Trip;
                    if(!matchedTripData){
                      throw new HttpsError('not-found', `trip not found for id ${matchedTrip.id}`)
                    }
                    const tripThatSoleMemberWasReservingMatchedTripIndex = tripThatSoleMemberWasReserving.matched_trips.findIndex(mt => mt.trip_ref.id === matchedTrip.id);

                    const tripThatSoleMemberWasReservingPotentialTripIndex = tripThatSoleMemberWasReserving.potential_trips.findIndex(pt => pt.trip_ref.id === matchedTrip.id);

                    if(tripThatSoleMemberWasReservingMatchedTripIndex != -1){
                        updateNestedTripField(
                          tripThatSoleMemberWasReservingUpdate,
                          'matched_trips',
                          tripThatSoleMemberWasReservingMatchedTripIndex,
                          'mutual',
                          true
                        );
                    } else {
                        if(tripThatSoleMemberWasReservingPotentialTripIndex != -1){
                          updateNestedTripField(
                            tripThatSoleMemberWasReservingUpdate,
                            'potential_trips',
                            tripThatSoleMemberWasReservingPotentialTripIndex,
                            'mutual',
                            false
                          );
                        }
                    }
                  }

                  transaction.update(reservedTripBySoleMemberRef, tripThatSoleMemberWasReservingUpdate);
              }

              //n25 All choice TG members trip documents update:
              for(const tripGroupMember of choiceTripGroup.trip_group_members){
                const memberTripRef = tripGroupMember.trip_ref;
                const memberTripUpdate: Partial<Trip> = {
                  total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
                }
                const matchedTripIndex = ((await transaction.get(memberTripRef)).data() as Trip)?.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
                if(matchedTripIndex != -1){
                    updateNestedTripField(memberTripUpdate, 'matched_trips', matchedTripIndex, 'paid', true);
                    updateNestedTripField(memberTripUpdate, 'matched_trips', matchedTripIndex, 'trip_group_ref', choiceTripGroupRef);
                }

                transaction.update(memberTripRef, memberTripUpdate);
              }}
            }else{
              // If only one trip group, it's the choice.
              choiceTripGroupRef = db.collection('trip_groups').doc(Array.from(distinctTripGroupIds)[0]);
              choiceTripGroup = (await transaction.get(choiceTripGroupRef)).data() as TripGroup;

            }
          } // End else (not reserved, not zero matched)
        }

          //common updates start here
          if (!choiceTripGroupRef || !choiceTripGroup) {
            // This *should* be caught earlier, but it's good to be defensive.
            throw new HttpsError("failed-precondition", "Choice Trip Group not assigned.");
          }

          //n26 Choice trip group document update:
          const choiceTripGroupUpdate: Partial<TripGroup> = {
            total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
          };
          // In it’s potential_trip_members field delete the element containing NPT
          const potentialTripMemberIndex = choiceTripGroup.potential_trip_members.findIndex(ptm => ptm.trip_ref.id === nptTrip.trip_id);
          if (potentialTripMemberIndex !== -1) {
            choiceTripGroupUpdate.potential_trip_members = FieldValue.arrayRemove(choiceTripGroup.potential_trip_members[potentialTripMemberIndex]) as any;
          }

          const user = await nptTripRef.parent.parent!.get(); // Fetch the user document.
          const userData = user.data() as User;
          if(!userData){
            throw new HttpsError('not-found', 'user data not found')
          }
            // Add new trip_group_members element
            const newTripGroupMember: TripGroupMember = { //n26
              trip_ref: nptTripRef,
              user_ref: nptTripRef.parent.parent!, // User ref
              first_name: userData.first_name,
              last_name: userData.last_name,
              phone_number: userData.phone_number,
              photo_url: userData.photo_url,
              seat_count: nptTrip.seat_count,
              joined_timestamp: Timestamp.now(),
              last_message_read_id: "", // Empty initially
              time_range_array: nptTrip.time_range_array, // NPT's time range
              arrived: false, // Initially false
              trip_group_leader: false, // Not the leader initially.  You'll need to handle leadership elsewhere
              canceled: false,
            };
            choiceTripGroupUpdate.trip_group_members = FieldValue.arrayUnion(newTripGroupMember) as any;
            transaction.update(choiceTripGroupRef, choiceTripGroupUpdate);

            //n27 In the choice TG’s potential trip members array, get all the trips that are not seat obstructed (seat_obstruction = false), but are now seat obstructed due to NPT’s entry
          const newlySeatObstructedPotentialTripMembers = choiceTripGroup.potential_trip_members
            .filter(ptm => !ptm.seat_obstruction && ptm.trip_ref.id !== nptTrip.trip_id)
            .filter(ptm => ptm.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count));

          //n28 Choice trip group document update:
          for (const ptm of newlySeatObstructedPotentialTripMembers) { //n28
            const ptmIndex = choiceTripGroup.potential_trip_members.findIndex(item => item.trip_ref.id === ptm.trip_ref.id);
              if (ptmIndex !== -1) {
                transaction.update(choiceTripGroupRef, {
                  [`potential_trip_members.${ptmIndex}.seat_obstruction`]: true,
                });
              }
            }

            //n29 In the choice TG’s potential trip members array, get all the potential trip members that do not proper match the NPT
          // Create array of check promises
          const potentialTripChecks = choiceTripGroup.potential_trip_members
          .filter(ptm => ptm.trip_ref.id !== nptTrip.trip_id)  // Exclude NPT (this filter is synchronous, so it's fine)
          .map(async ptm => {
            try {
              const potentialTripDoc = await transaction.get(ptm.trip_ref);
              const potentialTripMemberData = potentialTripDoc.data() as Trip;
              
              if (!potentialTripMemberData) {
                throw new HttpsError('not-found', 'potential trip member not found');
              }
              
              // Return the ptm if it doesn't proper match, otherwise null
              return !properMatchArrayCheck(nptTrip, potentialTripMemberData) ? ptm : null;
            } catch (error) {
              logger.error(`Error checking potential trip ${ptm.trip_ref.id}:`, error);
              return null;
            }
          });

          // Wait for all checks to complete and filter out nulls
          const nonProperMatchingPotentialTripMembers = (await Promise.all(potentialTripChecks))
          .filter(ptm => ptm !== null);

            //n30, n31, n32
          for (const ptm of nonProperMatchingPotentialTripMembers) { //n30
            const ptmIndex = choiceTripGroup.potential_trip_members.findIndex(item => item.trip_ref.id === ptm.trip_ref.id);
            if (ptmIndex !== -1) {
              const potentialTripMemberData = (await transaction.get(ptm.trip_ref)).data() as Trip;
              if(!potentialTripMemberData){
                throw new HttpsError('not-found', 'potential trip member not found')
              }

              const distance = getStoredDistances(nptTrip, ptm.trip_ref);
              
              const pickupGap = calculateGap(nptTrip, potentialTripMemberData, 'pickup', distance?.pickupDistance);
              const destinationGap = calculateGap(nptTrip, potentialTripMemberData, 'destination', distance?.destinationDistance);

              //n32
              const newObstructingMember = {
                  trip_ref: nptTripRef,
                  pickup_overlap_gap: pickupGap,
                  destination_overlap_gap: destinationGap,
                  unknown: distance ? false : true, //n32
                };

                const existingObstructingMembers = choiceTripGroup.potential_trip_members[ptmIndex]?.obstructing_trip_members || [];
                const updatedObstructingMembers = [...existingObstructingMembers, newObstructingMember];
                transaction.update(choiceTripGroupRef, {
                  [`potential_trip_members.${ptmIndex}.trip_obstruction`]: true, //n30
                  [`potential_trip_members.${ptmIndex}.obstructing_trip_members`]: updatedObstructingMembers
                });
            }
          }

            //n33 In the choice TG’s potential_trips array, get all the trips that were originally seat obstructed or trip obstructed or both, prior to the NPT’s entry
          const originallyObstructedPotentialTrips = choiceTripGroup.potential_trip_members
            .filter(ptm => ptm.trip_ref.id !== nptTrip.trip_id) // Exclude NPT
            .filter(ptm => ptm.seat_obstruction || ptm.trip_obstruction);
          
            //n34
          for(const ptm of originallyObstructedPotentialTrips){ //n34
            const tripData = (await transaction.get(ptm.trip_ref)).data() as Trip;
            if (!tripData) {
                throw new HttpsError("not-found", `Trip data is null for trip ID: ${ptm.trip_ref.id}, skipping...`);
            }
            const potentialTripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === nptTrip.trip_id);
            if(potentialTripIndex != -1){
              transaction.update(ptm.trip_ref, {
                [`potential_trips.${potentialTripIndex}.total_seat_count`]: choiceTripGroup.total_seat_count + nptTrip.seat_count,
              });
            }
          }

            //n35 In the choice TG’s potential_trips array, get all the trips that were not obstructed at all, but are now seat obstructed or trip obstructed or both, due to the addition of NPT to the TG
          // const newlyObstructedPotentialTripMembers = choiceTripGroup.potential_trip_members
          //   .filter(ptm => ptm.trip_ref.id !== nptTrip.trip_id) // Exclude NPT
          //   .filter(ptm => {
          //       const wasNotObstructed = !ptm.seat_obstruction && !ptm.trip_obstruction;
          //       const isNowSeatObstructed = ptm.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count);

          //       // Check for new trip obstruction by going through each choiceTripGroup member (including the new one, NPT)
          //       let isNowTripObstructed = false;

          //       if(wasNotObstructed){ //only check if it wasn't obstructed before
          //         for (const member of [...choiceTripGroup.trip_group_members, newTripGroupMember]) { // Include NPT
          //           const memberTrip = transaction.get(member.trip_ref).then(doc => doc.data() as Trip);
          //           if(!memberTrip){
          //             logger.warn('Member trip not found')
          //             continue
          //           }

          //           memberTrip.then(async memberTripData => {
          //               //check if its not the member itself
          //               if(memberTripData.trip_id != ptm.trip_ref.id){
          //                 const ptmTripData = (await transaction.get(ptm.trip_ref)).data() as Trip;
          //                 if (!properMatchArrayCheck(memberTripData, ptmTripData)) { //check if it doesn't proper match each member
          //                     isNowTripObstructed = true;
          //                     //No break statement because we want to go through every member
          //                 }
          //               }
          //           })
          //           .catch(error => {
          //             logger.error(`Error while getting memberTrip: ${error}`);
          //           });
          //         }
          //       }

          //       return wasNotObstructed && (isNowSeatObstructed || isNowTripObstructed);
          //   });
          
          const checkNewObstructions = async (ptm: PotentialTripMember) => {
            // Skip NPT
            if (ptm.trip_ref.id === nptTrip.trip_id) return false;
          
            const wasNotObstructed = !ptm.seat_obstruction && !ptm.trip_obstruction;
            
            // If it was already obstructed, no need to check further
            if (!wasNotObstructed) return false;
            
            const isNowSeatObstructed = ptm.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count);
            
            // If seat obstructed, we already know it's newly obstructed
            if (isNowSeatObstructed) return true;
            
            // Check for new trip obstruction
            try {
              const ptmTripDoc = await transaction.get(ptm.trip_ref);
              const ptmTripData = ptmTripDoc.data() as Trip;
              
              if (!ptmTripData) {
                logger.warn(`PTM trip not found for ID: ${ptm.trip_ref.id}`);
                return false;
              }
              
              // Check if they don't proper match
              if (!properMatchArrayCheck(nptTrip, ptmTripData)) {
                return true; // Found an obstruction, can return early
              }
              
              // No obstructions found
              return false;
            } catch (error) {
              logger.error(`Error checking obstructions: ${error}`);
              return false;
            }
          };
          
          // Run all the checks and collect results
          const obstructionChecks = choiceTripGroup.potential_trip_members.map(checkNewObstructions);
          const obstructionResults = await Promise.all(obstructionChecks);
          
          // Filter based on the results
          const newlyObstructedPotentialTripMembers = choiceTripGroup.potential_trip_members
            .filter((_, index) => obstructionResults[index]);


          //n36
          for (const ptm of newlyObstructedPotentialTripMembers) { //n36
            const ptmTripRef = ptm.trip_ref;
            const ptmTrip = (await transaction.get(ptmTripRef)).data() as Trip;

            if (!ptmTrip) {
              throw new HttpsError("not-found", `Trip data is null for trip ID: ${ptmTripRef.id}, skipping...`);
            }

            const ptmTripUpdate: Partial<Trip> = {};

            // In each of their matched_trips array fields, delete all the elements containing the choice TG trip members
            for (const member of choiceTripGroup.trip_group_members) { //choice trip group members
              const memberIndex = ptmTrip.matched_trips.findIndex(mt => mt.trip_ref.id === member.trip_ref.id);
              if (memberIndex !== -1) {
                ptmTripUpdate.matched_trips = FieldValue.arrayRemove(ptmTrip.matched_trips[memberIndex]) as any;
              }
            }

            //add new elements to potential trips
            for(const member of choiceTripGroup.trip_group_members){
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                if(!memberTrip){
                  logger.warn('Member trip not found');
                  continue;
                }
                // const memberTripData = (await transaction.get(member.trip_ref)).data() as Trip;

                // if(!memberTripData){
                //   throw new HttpsError('not-found', "member trip not found");
                // }

                const distance = getStoredDistances(memberTrip, ptm.trip_ref);

                if(!distance){
                  throw new HttpsError('not-found', 'distance not found')
                }

                const pickupGap = calculateGap(ptmTrip, memberTrip, 'pickup', distance?.pickupDistance);
                const destinationGap = calculateGap(ptmTrip, memberTrip, 'destination', distance?.destinationDistance);
                
                const potentialTripToBeAdded: PotentialTrip = { //n36 +++
                    trip_ref: member.trip_ref,
                    pickup_radius: memberTrip.pickup_radius,
                    destination_radius: memberTrip.destination_radius,
                    pickup_distance: distance?.pickupDistance,
                    destination_distance: distance?.destinationDistance,
                    paid: true,
                    trip_group_ref: choiceTripGroupRef,
                    proper_match: true,
                    trip_obstruction: properMatchArrayCheck(ptmTrip, memberTrip),
                    seat_obstruction: ptmTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count), // Check seat obstruction with new total
                    reserving_trip_obstruction: false,
                    mutual: !ptmTrip.matched_trips.find(mt => mt.trip_ref.id === member.trip_ref.id)?.mutual, // Opposite of matched
                    group_largest_pickup_overlap_gap: !properMatchArrayCheck(ptmTrip, nptTrip) ? pickupGap: null, //n36
                    group_largest_destination_overlap_gap: !properMatchArrayCheck(ptmTrip, nptTrip) ? destinationGap: null, //n36
                    unknown_trip_obstruction: await checkAnyMemberUnknownToTrip(ptmTripRef, choiceTripGroup.trip_group_members, transaction),
                    total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
                    seat_count: ptmTrip.seat_count,
                  };

                ptmTripUpdate.potential_trips = FieldValue.arrayUnion(potentialTripToBeAdded) as any;

            }
            transaction.update(ptmTripRef, ptmTripUpdate);
          }

          //n37 From the choice TG’s potential_trip_members that weren't obstructed but have just been obstructed, check for the ones that do not have any other matched trip apart from the just removed choice TG members
          const checkPromises = newlyObstructedPotentialTripMembers.map(async ptm => {
            try {
              const ptmTripDoc = await transaction.get(ptm.trip_ref);
              const ptmTrip = ptmTripDoc.data() as Trip;
              
              if (!ptmTrip) {
                logger.warn(`Trip not found for ID: ${ptm.trip_ref.id}`);
                return null;
              }
              
              // Return the item if condition is met, otherwise null
              return ptmTrip.matched_trips.length === 1 ? ptm : null;
            } catch (error) {
              logger.error(`Error checking trip ${ptm.trip_ref.id}:`, error);
              return null;
            }
          });
          
          // Then wait for all promises to resolve and filter out nulls
          const newlyObstructedPotentialTripMembersWithNoOtherMatches = (await Promise.all(checkPromises))
            .filter(result => result !== null);

          //n38 All choice TG potential_trip_members that do not have any other matched_trip’s document update:
          for(const ptm of await newlyObstructedPotentialTripMembersWithNoOtherMatches){ //n38
            transaction.update(ptm.trip_ref, {
              status: "unmatched"
            });
          }

          //n39 All choice TG members trip document update:
          for (const member of choiceTripGroup.trip_group_members) { //n39

            const memberTripRef = member.trip_ref;
            const memberTrip = (await transaction.get(memberTripRef)).data() as Trip;
            if(!memberTrip){
              throw new HttpsError('not-found', 'member trip not found')
            }
            for(const ptm of newlyObstructedPotentialTripMembers){
              const memberTripUpdate: Partial<Trip> = {};
              const matchedTripIndex = memberTrip.matched_trips.findIndex(mt => mt.trip_ref.id === ptm.trip_ref.id);
              const potentialTripIndex = memberTrip.potential_trips.findIndex(pt => pt.trip_ref.id === ptm.trip_ref.id);

              if(matchedTripIndex != -1){ //if its in matched trips
                updateNestedTripField(memberTripUpdate, 'matched_trips', matchedTripIndex, 'mutual', !memberTrip.matched_trips[matchedTripIndex].mutual);
              }

              if(potentialTripIndex != -1){ //if its in potential trips
                updateNestedTripField(
                  memberTripUpdate,
                  'potential_trips',
                  potentialTripIndex,
                  'mutual',
                  !memberTrip.potential_trips[potentialTripIndex].mutual
                );
              }
              transaction.update(memberTripRef, memberTripUpdate);
            }
          }

            //n40 Get all NPT’s matched trips (exclude choice TG’s members) and potential trips
            const nptMatchedTripsExcludingChoiceTG = nptTrip.matched_trips
                .filter(mt => !choiceTripGroup.trip_group_members.some(member => member.trip_ref.id === mt.trip_ref.id));
            const nptPotentialTrips = nptTrip.potential_trips
             //no need to exclude, potential trips can't be in trip group already

            const nptRelatedTripsNotAlreadyInChoiceTG = [...nptMatchedTripsExcludingChoiceTG, ...nptPotentialTrips]
                .filter(relatedTrip => !choiceTripGroup.potential_trip_members.some(ptm => ptm.trip_ref.id === relatedTrip.trip_ref.id));

            //n41 Choice TG document update:
            for(const relatedTrip of nptRelatedTripsNotAlreadyInChoiceTG){ //n41

                const relatedTripData = (await transaction.get(relatedTrip.trip_ref)).data() as Trip;
                if (!relatedTripData) {
                    throw new HttpsError("not-found", `Trip data is null for trip ID: ${relatedTrip.trip_ref.id}, skipping...`);
                }

              let tripObstruction = false;
              let obstructingTripMembers = [];
              
              for (const member of [...choiceTripGroup.trip_group_members, newTripGroupMember]) { // Include NPT
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                if (!memberTrip) {
                    logger.warn(`Trip data is null for trip ID: ${member.trip_ref.id}, skipping...`);
                    continue; // Skip if member trip not found.
                }

                if(!properMatchArrayCheck(memberTrip, relatedTripData)){ //check with member, including NPT
                  tripObstruction = true;

                  const distance = getStoredDistances(memberTrip, relatedTrip.trip_ref);

                  const pickupGap = calculateGap(memberTrip, relatedTripData, 'pickup', distance?.pickupDistance);
                  const destinationGap = calculateGap(memberTrip, relatedTripData, 'destination', distance?.destinationDistance);

                  obstructingTripMembers.push({
                      trip_ref: member.trip_ref,
                      pickup_overlap_gap: pickupGap,
                      destination_overlap_gap: destinationGap,
                      unknown: distance ? false : true, //n41
                  });
                }
              }

              const potentialTripMember: PotentialTripMember = {
                  trip_ref: relatedTrip.trip_ref,
                  obstructing_trip_members: obstructingTripMembers, //n41
                  trip_obstruction: tripObstruction, //n41
                  seat_obstruction: relatedTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count), //n41
                  seat_count: relatedTrip.seat_count,
                  unknown_trip_obstruction: await checkAnyMemberUnknownToTrip(relatedTrip.trip_ref, choiceTripGroup.trip_group_members, transaction), //n41
              };

              transaction.update(choiceTripGroupRef, {
                  potential_trip_members: FieldValue.arrayUnion(potentialTripMember) as any,
              });
            }
            //n42 Get all NPT’s matched trips (excluding the choice TG members) with mutual as true
            const nptMatchedTripsMutualTrueExcludingChoiceTG = nptTrip.matched_trips
                .filter(mt => mt.mutual && !choiceTripGroup.trip_group_members.some(member => member.trip_ref.id === mt.trip_ref.id));
            
            const newlyObstructedMatchedTrips: DocumentReference[] = [];

            for(const matchedTrip of nptMatchedTripsMutualTrueExcludingChoiceTG){
              const matchedTripData = (await transaction.get(matchedTrip.trip_ref)).data() as Trip;
              if (!matchedTripData) {
                throw new HttpsError("not-found", `Trip data is null for trip ID: ${matchedTrip.trip_ref.id}, skipping...`);
              }
                //find the ones who do not proper match all the members of the choice TG
              let doesNotProperMatchAll = false;
              for (const member of choiceTripGroup.trip_group_members) {
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                if (!memberTrip) {
                    logger.warn(`Member trip data not found for trip ID: ${member.trip_ref.id}`);
                    continue; // Skip if member trip not found.
                }

                if (!properMatchArrayCheck(memberTrip, matchedTripData)) {
                  doesNotProperMatchAll = true;
                  break;
                }
              }
                //or whose seat_count is greater than 4 - (choice TG total_seat_count + NPT’s seat count)
              if(doesNotProperMatchAll || matchedTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count)){
                newlyObstructedMatchedTrips.push(matchedTrip.trip_ref);
              }
            }

            //n43
            for(const matchedTripRef of newlyObstructedMatchedTrips){ //n43
                const matchedTrip = (await transaction.get(matchedTripRef)).data() as Trip;
                if (!matchedTrip) {
                  throw new HttpsError("not-found", `Trip data is null for trip ID: ${matchedTripRef.id}, skipping...`);
                }
                const matchedTripUpdate: Partial<Trip> = {};
                  //In each of their matched trips array field, delete the element containing the NPT
                const matchedTripMatchedTripIndex = matchedTrip.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
                if (matchedTripMatchedTripIndex !== -1) {
                  matchedTripUpdate.matched_trips = FieldValue.arrayRemove(matchedTrip.matched_trips[matchedTripMatchedTripIndex]) as any;
                }
                //Add NPT to each of their potential_trips array
                const potentialTripToBeAdded: PotentialTrip = { //n43
                    trip_ref: nptTripRef,
                    paid: true,
                    trip_group_ref: nptTrip.trip_group_ref,
                    pickup_radius: nptTrip.pickup_radius,
                    destination_radius: nptTrip.destination_radius,
                    pickup_distance: matchedTrip.matched_trips[matchedTripMatchedTripIndex].pickup_distance,
                    destination_distance: matchedTrip.matched_trips[matchedTripMatchedTripIndex].destination_distance,
                    proper_match: true,
                    trip_obstruction: false, //n43 may be T or F
                    seat_obstruction: matchedTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count), //n43 may be T or F
                    reserving_trip_obstruction: false,
                    mutual: false,
                    group_largest_pickup_overlap_gap: null, //n43
                    group_largest_destination_overlap_gap: null, //n43
                    unknown_trip_obstruction: await checkAnyMemberUnknownToTrip(matchedTripRef, choiceTripGroup.trip_group_members, transaction), //n43
                    total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
                    seat_count: nptTrip.seat_count,
                };

              // Check gaps
              let tripObstruction = false;
              let largestPickupOverlapGap = 0;
              let largestDestinationOverlapGap = 0;
              for (const member of choiceTripGroup.trip_group_members) {
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                if (!memberTrip) {
                    logger.warn(`Member trip data not found for trip ID: ${member.trip_ref.id}`);
                    continue;
                }

                if(!properMatchArrayCheck(memberTrip, matchedTrip)){
                    tripObstruction = true;
                    const distance = getStoredDistances(memberTrip, matchedTripRef);
                    const pickupGap = calculateGap(memberTrip, matchedTrip, 'pickup', distance?.pickupDistance);
                    const destinationGap = calculateGap(memberTrip, matchedTrip, 'destination', distance?.destinationDistance);
                    if (!pickupGap || !destinationGap) {
                      logger.warn(`Member trip: ${member.trip_ref.id}`, `unknown to trip ID: ${matchedTripRef}`);
                      continue;
                    }
                    if (pickupGap > largestPickupOverlapGap) {
                      largestPickupOverlapGap = pickupGap;
                    }
                    if (destinationGap > largestDestinationOverlapGap) {
                      largestDestinationOverlapGap = destinationGap;
                    }
                }
              }
              potentialTripToBeAdded.group_largest_pickup_overlap_gap = largestPickupOverlapGap === 0 ? null : largestPickupOverlapGap;
              potentialTripToBeAdded.group_largest_destination_overlap_gap = largestDestinationOverlapGap === 0 ? null : largestDestinationOverlapGap;
              potentialTripToBeAdded.trip_obstruction = tripObstruction; //update
              matchedTripUpdate.potential_trips = FieldValue.arrayUnion(potentialTripToBeAdded) as any;


              transaction.update(matchedTripRef, matchedTripUpdate);
            }

            //n44 From the NPT’s newly obstructed matched trips (excluding choice TG members) with mutual as true, get the ones that had only the NPT in their matched_trip array
            // Create array of check promises
            const matchedChecks = newlyObstructedMatchedTrips.map(async (tripRef) => {
              try {
                const tripDoc = await transaction.get(tripRef);
                const tripData = tripDoc.data() as Trip;
                
                if (!tripData) {
                  logger.warn(`trip not found for ${tripRef.id}`);
                  return null;
                }
                
                // Return the tripRef if condition is met, otherwise null
                if (tripData.matched_trips.length === 1 && 
                    tripData.matched_trips[0].trip_ref.id === nptTrip.trip_id) {
                  return tripRef;
                }
                return null;
              } catch (error) {
                logger.error(`Error checking matched trip ${tripRef.id}:`, error);
                return null;
              }
            });

            // Wait for all checks to complete and filter out nulls
            const newlyObstructedMatchedTripsOnlyNPT = (await Promise.all(matchedChecks))
              .filter(tripRef => tripRef !== null);
                
            //n45 All the NPT’s newly obstructed matched trips (excluding choice TG members) with mutual as true that had only the NPT in their matched_trip array documents updates:
            for(const tripRef of await newlyObstructedMatchedTripsOnlyNPT){ //n45
              transaction.update(tripRef, {
                status: "unmatched",
              });
            }

            //n46 NPT document update:
            const nptUpdateForNewlyObstructedMatchedTrips: Partial<Trip> = {}; //n46
            for(const matchedTripRef of newlyObstructedMatchedTrips){
              const nptMatchedTripIndex = nptTrip.matched_trips.findIndex(mt => mt.trip_ref.id === matchedTripRef.id);
              if (nptMatchedTripIndex !== -1) {
                updateNestedTripField(
                  nptUpdateForNewlyObstructedMatchedTrips,
                  'matched_trips',
                  nptMatchedTripIndex,
                  'mutual',
                  false
                );
              }
            }
            transaction.update(nptTripRef, nptUpdateForNewlyObstructedMatchedTrips);

            //n47 Rest of NPT’s matched_trips (excluding choice TG members) with mutual as true that aren't trip or seat obstructed updates:
            const restOfNptMatchedTripsMutualTrue = nptTrip.matched_trips //n47
                .filter(mt => mt.mutual && !choiceTripGroup.trip_group_members.some(member => member.trip_ref.id === mt.trip_ref.id))
                .filter(mt => !newlyObstructedMatchedTrips.some(tripRef => tripRef.id === mt.trip_ref.id));

            for(const matchedTrip of restOfNptMatchedTripsMutualTrue){
              const matchedTripUpdate: Partial<Trip> = {};
              const matchedTripIndex = ((await transaction.get(matchedTrip.trip_ref)).data() as Trip)?.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
              if (matchedTripIndex !== -1) {
                updateNestedTripField(matchedTripUpdate, 'matched_trips', matchedTripIndex, 'paid', true);
                updateNestedTripField(matchedTripUpdate, 'matched_trips', matchedTripIndex, 'trip_group_ref', choiceTripGroupRef);
              }
              transaction.update(matchedTrip.trip_ref, matchedTripUpdate);
            }

            //n48 Get all NPT’s potential trips with mutual as false,
            const nptPotentialTripsMutualFalse = nptTrip.potential_trips.filter(pt => !pt.mutual);
            const newlyObstructedPotentialTrips: DocumentReference[] = [];

            for(const potentialTrip of nptPotentialTripsMutualFalse){
              const potentialTripData = (await transaction.get(potentialTrip.trip_ref)).data() as Trip;
              if (!potentialTripData) {
                throw new HttpsError("not-found", `Trip data is null for trip ID: ${potentialTrip.trip_ref.id}, skipping...`);
              }
                //find the ones who do not proper match all the members of the choice TG
              let doesNotProperMatchAll = false;
              for (const member of choiceTripGroup.trip_group_members) {
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                if (!memberTrip) {
                    logger.warn(`Member trip data not found for trip ID: ${member.trip_ref.id}`);
                    continue;
                }
                if (!properMatchArrayCheck(memberTrip, potentialTripData)) {
                  doesNotProperMatchAll = true;
                  break;
                }
              }
                //or whose seat_count is greater than 4 - (choice TG total_seat_count + NPT’s seat count)
              if(doesNotProperMatchAll || potentialTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count)){
                newlyObstructedPotentialTrips.push(potentialTrip.trip_ref);
              }
            }

            //n49
            for(const potentialTripRef of newlyObstructedPotentialTrips){ //n49
              const potentialTrip = (await transaction.get(potentialTripRef)).data() as Trip;

              if (!potentialTrip) {
                throw new HttpsError("not-found", `Trip data is null for trip ID: ${potentialTripRef.id}, skipping...`);
              }
              const potentialTripUpdate: Partial<Trip> = {};
              //In each of their matched trips array field, delete the element containing the NPT
              const potentialTripMatchedTripIndex = potentialTrip.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
              if (potentialTripMatchedTripIndex !== -1) {
                potentialTripUpdate.matched_trips = FieldValue.arrayRemove(potentialTrip.matched_trips[potentialTripMatchedTripIndex]) as any;
              }
              //Add NPT to each of their potential_trips array
              const potentialTripToBeAdded: PotentialTrip = { //n49
                  trip_ref: nptTripRef,
                  paid: true,
                  trip_group_ref: nptTrip.trip_group_ref,
                  pickup_radius: nptTrip.pickup_radius,
                  destination_radius: nptTrip.destination_radius,
                  pickup_distance: potentialTrip.matched_trips[potentialTripMatchedTripIndex].pickup_distance,
                  destination_distance: potentialTrip.matched_trips[potentialTripMatchedTripIndex].destination_distance,
                  proper_match: true,
                  trip_obstruction: false, //may be T or F
                  seat_obstruction: potentialTrip.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count), //may be T or F
                  reserving_trip_obstruction: false,
                  mutual: true,
                  group_largest_pickup_overlap_gap: null, //n49
                  group_largest_destination_overlap_gap: null, //n49
                  unknown_trip_obstruction: await checkAnyMemberUnknownToTrip(potentialTripRef, choiceTripGroup.trip_group_members, transaction), //n49
                  total_seat_count: choiceTripGroup.total_seat_count + nptTrip.seat_count,
                  seat_count: nptTrip.seat_count,

              };

              //check gaps
              let tripObstruction = false;
              let largestPickupOverlapGap = 0;
              let largestDestinationOverlapGap = 0;
              for (const member of choiceTripGroup.trip_group_members) {
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                if (!memberTrip) {
                  logger.warn('member data not found');
                    continue;
                }

                if(!properMatchArrayCheck(memberTrip, potentialTrip)){
                  tripObstruction = true;
                  const distance = getStoredDistances(memberTrip, potentialTripRef);
                  const pickupGap = calculateGap(memberTrip, potentialTrip, 'pickup', distance?.pickupDistance);
                  const destinationGap = calculateGap(memberTrip, potentialTrip, 'destination', distance?.destinationDistance);

                  if (!pickupGap || !destinationGap) {
                    logger.warn(`Member trip: ${member.trip_ref.id}`, `unknown to trip ID: ${potentialTripRef}`);
                    continue;
                  }
                  if (pickupGap > largestPickupOverlapGap) {
                    largestPickupOverlapGap = pickupGap;
                  }
                  if (destinationGap > largestDestinationOverlapGap) {
                    largestDestinationOverlapGap = destinationGap;
                  }
                }
              }
              potentialTripToBeAdded.trip_obstruction = tripObstruction;
              potentialTripToBeAdded.group_largest_pickup_overlap_gap = largestPickupOverlapGap === 0 ? null : largestPickupOverlapGap;
              potentialTripToBeAdded.group_largest_destination_overlap_gap = largestDestinationOverlapGap === 0 ? null : largestDestinationOverlapGap;
              
              potentialTripUpdate.potential_trips = FieldValue.arrayUnion(potentialTripToBeAdded) as any;

              transaction.update(potentialTripRef, potentialTripUpdate);
            }

            //n50
            const potentialChecks = newlyObstructedPotentialTrips.map(async (tripRef) => {
              try {
                const tripDoc = await transaction.get(tripRef);
                const tripData = tripDoc.data() as Trip;
                
                if (!tripData) {
                  logger.warn(`trip not found for ${tripRef.id}`);
                  return null;
                }
                
                // Return the tripRef if condition is met, otherwise null
                if (tripData.matched_trips.length === 1 && 
                    tripData.matched_trips[0].trip_ref.id === nptTrip.trip_id) {
                  return tripRef;
                }
                return null;
              } catch (error) {
                logger.error(`Error checking matched trip ${tripRef.id}:`, error);
                return null;
              }
            });

            // Wait for all checks to complete and filter out nulls
            const newlyObstructedPotentialTripsOnlyNPT = (await Promise.all(potentialChecks))
              .filter(tripRef => tripRef !== null);
                
            //n51
            for(const tripRef of await newlyObstructedPotentialTripsOnlyNPT){ //n51
              transaction.update(tripRef, {
                status: "unmatched"
              });
            }

            //n52
            const nptUpdateForNewlyObstructedPotentialTrips: Partial<Trip> = {}; //n52
            for(const potentialTripRef of newlyObstructedPotentialTrips){
              const nptPotentialTripIndex = nptTrip.potential_trips.findIndex(pt => pt.trip_ref.id === potentialTripRef.id);
              if(nptPotentialTripIndex != -1){
                    updateNestedTripField(
                    nptUpdateForNewlyObstructedPotentialTrips,
                    'potential_trips',
                    nptPotentialTripIndex,
                    'mutual',
                    true
                    );
              }
            }
            transaction.update(nptTripRef, nptUpdateForNewlyObstructedPotentialTrips)

            //n53
            const restOfNptPotentialTripsMutualFalse = nptTrip.potential_trips //n53
                .filter(pt => !pt.mutual)
                .filter(pt => !newlyObstructedPotentialTrips.some(tripRef => tripRef.id === pt.trip_ref.id));

            for(const potentialTrip of restOfNptPotentialTripsMutualFalse){
                const potentialTripUpdate: Partial<Trip> = {};
                const potentialTripIndex = ((await transaction.get(potentialTrip.trip_ref)).data() as Trip)?.matched_trips.findIndex(mt => mt.trip_ref.id === nptTrip.trip_id);
                if(potentialTripIndex != -1){
                    updateNestedTripField(potentialTripUpdate, 'matched_trips', potentialTripIndex, 'paid', true);
                    updateNestedTripField(potentialTripUpdate, 'matched_trips', potentialTripIndex, 'trip_group_ref', choiceTripGroupRef);
                }
                transaction.update(potentialTrip.trip_ref, potentialTripUpdate)
            }

            //n54 All NPT’s matched trip’s with mutual as “false” & potential trip’s with mutual as “true” document updates:
            const nptMatchedTripsMutualFalse = nptTrip.matched_trips.filter(mt => !mt.mutual);
            const nptPotentialTripsMutualTrue = nptTrip.potential_trips.filter(pt => pt.mutual);

            for (const trip of [...nptMatchedTripsMutualFalse, ...nptPotentialTripsMutualTrue]) { //n54
              const tripData = (await transaction.get(trip.trip_ref)).data() as Trip;
              if (!tripData) {
                throw new HttpsError("not-found", `Trip data is null for trip ID: ${trip.trip_ref.id}, skipping...`);
              }
                const tripUpdate: Partial<Trip> = {};

                const matchedTripPotentialTripIndex = tripData.potential_trips.findIndex(pt => pt.trip_ref.id === nptTrip.trip_id);

                if(matchedTripPotentialTripIndex != -1){
                  let largestPickupOverlapGap = 0;
                  let largestDestinationOverlapGap = 0;
                  for (const member of choiceTripGroup.trip_group_members) {
                    const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                    if (!memberTrip) {
                      logger.warn('member data not found');
                        continue;
                    }

                    if(!properMatchArrayCheck(memberTrip, tripData)){
                      const distance = getStoredDistances(memberTrip, trip.trip_ref);
                      const pickupGap = calculateGap(memberTrip, tripData, 'pickup', distance?.pickupDistance);
                      const destinationGap = calculateGap(memberTrip, tripData, 'destination', distance?.destinationDistance);

                      if (!pickupGap || !destinationGap) {
                        logger.warn(`Member trip: ${member.trip_ref.id}`, `unknown to trip ID: ${trip.trip_ref}`);
                        continue;
                      }
                      if (pickupGap > largestPickupOverlapGap) {
                        largestPickupOverlapGap = pickupGap;
                      }
                      if (destinationGap > largestDestinationOverlapGap) {
                        largestDestinationOverlapGap = destinationGap;
                      }
                    }
                  }
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'paid', true);
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'trip_group_ref', choiceTripGroupRef);
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'trip_obstruction', true);
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'seat_obstruction', tripData.seat_count > 4 - (choiceTripGroup.total_seat_count + nptTrip.seat_count));
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'reserving_trip_obstruction', false);
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'group_largest_pickup_overlap_gap', largestPickupOverlapGap === 0 ? null : largestPickupOverlapGap); //n54
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'group_largest_destination_overlap_gap', largestDestinationOverlapGap === 0 ? null : largestDestinationOverlapGap); //n54
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'unknown_trip_obstruction', false); //n54
                  updateNestedTripField(tripUpdate, 'potential_trips', matchedTripPotentialTripIndex, 'total_seat_count', choiceTripGroup.total_seat_count + nptTrip.seat_count);
                }
                transaction.update(trip.trip_ref, tripUpdate);
            }

            //n55
            let newPickupSuggestions = false; //n55
            let newDestinationSuggestions = false; //n55
            let timeArrayChanged = false; //n55
            let tripGroupTimeRangeArray: string[] = []; //n55

            //n76 Does the NPT have the same pickup_latlng with any member of the choice TG?
            let samePickup = false;
            let samePickupMember: TripGroupMember | undefined;

            for (const member of choiceTripGroup.trip_group_members) { //n76
              const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

              if (!memberTrip) {
                  logger.warn(`Member trip data not found for trip ID: ${member.trip_ref.id}`);
                  continue;
              }
                if (memberTrip.pickup_latlng.lat === nptTrip.pickup_latlng.lat && memberTrip.pickup_latlng.lng === nptTrip.pickup_latlng.lng) {
                  samePickup = true;
                  samePickupMember = member;
                  break;
                }
            }

            if(samePickup && samePickupMember){ //n77
              const choiceTripGroupUpdateForPickup: Partial<TripGroup> = {};
              
              for (const suggestion of choiceTripGroup.pickup_location_suggestions) { //loop
                const distances = suggestion.distances_from_trip_pickup_locations;

                const newDistance = {
                    trip_id: nptTrip.trip_id,
                    walking_distance: distanceBetween( //walking distance
                        { lat: suggestion.pickup_suggestion_location.lat, lng: suggestion.pickup_suggestion_location.lng },
                        nptTrip.pickup_latlng
                    ),
                };

                distances.push(newDistance);

                const suggestionIndex = choiceTripGroup.pickup_location_suggestions.findIndex(s => s.pickup_suggestion_name === suggestion.pickup_suggestion_name);

                if(suggestionIndex != -1){
                    updateNestedTripField(
                      choiceTripGroupUpdateForPickup,
                      'pickup_location_suggestions',
                      suggestionIndex,
                      'distances_from_trip_pickup_locations',
                      distances
                    );
                }
              }
              transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForPickup);
            }

            const numberOfTripGroupMembers = choiceTripGroup.trip_group_members.length; //n78

            if(numberOfTripGroupMembers > 1 && samePickup && samePickupMember){ //n79
                //Choice trip group document updateIn it’s pickup_location_suggestions field add new element
              const choiceTripGroupUpdateForPickup: Partial<TripGroup> = {};
              const pickupSuggestion= {
                pickup_suggestion_name: nptTrip.pickup_short_description,
                pickup_suggestion_address: nptTrip.pickup_address,
                pickup_suggestion_location: nptTrip.pickup_latlng,
                distances_from_trip_pickup_locations: [
                    {
                        trip_id: nptTrip.trip_id,
                        walking_distance: 0,
                    },
                    {
                        trip_id: samePickupMember.trip_ref.id, // Assuming you have the other member's trip ID
                        walking_distance: 0, // Since it's the same location
                    },
                ],
                pickup_suggestion_voters: [],
            };

            choiceTripGroupUpdateForPickup.pickup_location_suggestions = FieldValue.arrayUnion(pickupSuggestion) as any;

            transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForPickup);
            newPickupSuggestions = true; //n80

            }

            if(numberOfTripGroupMembers > 1 && !samePickup){ //n81
              newPickupSuggestions = true;
            }

            //n89 Does the NPT have the same destination_latlng with any member of the choice TG?
            let sameDestination = false;
            let sameDestinationMember: TripGroupMember | undefined;
            for (const member of choiceTripGroup.trip_group_members) { //n89
                const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                if (!memberTrip) {
                    logger.warn(`Member trip data not found for trip ID: ${member.trip_ref.id}`);
                    continue;
                }
                if (memberTrip.destination_latlng.lat === nptTrip.destination_latlng.lat && memberTrip.destination_latlng.lng === nptTrip.destination_latlng.lng) {
                  sameDestination = true;
                  sameDestinationMember = member;
                  break;
                }
            }

            if(sameDestination && sameDestinationMember){ //n92
              const choiceTripGroupUpdateForDestination: Partial<TripGroup> = {};

              for (const suggestion of choiceTripGroup.destination_suggestions) { //loop through the destination suggestions
                const distances = suggestion.distances_from_trip_destinations;

                const newDistance = {
                    trip_id: nptTrip.trip_id,
                    walking_distance: distanceBetween( //walking distance
                        { lat: suggestion.destination_suggestion_location.lat, lng: suggestion.destination_suggestion_location.lng },
                        nptTrip.destination_latlng
                    ),
                };

                distances.push(newDistance);

                const suggestionIndex = choiceTripGroup.destination_suggestions.findIndex(s => s.destination_suggestion_name === suggestion.destination_suggestion_name);

                if(suggestionIndex != -1){
                    updateNestedTripField(
                    choiceTripGroupUpdateForDestination,
                    'destination_suggestions',
                    suggestionIndex,
                    'distances_from_trip_destinations',
                    distances
                    );
                }
              }
              transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForDestination);
            }

            if(numberOfTripGroupMembers > 1 && sameDestination && sameDestinationMember){ //n91
                //Choice trip group document update
              const choiceTripGroupUpdateForDestination: Partial<TripGroup> = {};
              const destinationSuggestion = {
                destination_suggestion_name: nptTrip.destination_short_description,
                destination_suggestion_address: nptTrip.destination_address,
                destination_suggestion_location: nptTrip.destination_latlng,
                distances_from_trip_destinations: [
                    {
                        trip_id: nptTrip.trip_id,
                        walking_distance: 0,
                    },
                    {
                        trip_id: sameDestinationMember.trip_ref.id,
                        walking_distance: 0,
                    },
                ],
                destination_suggestion_voters: [],
            };

              choiceTripGroupUpdateForDestination.destination_suggestions = FieldValue.arrayUnion(destinationSuggestion) as any;
              transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForDestination);
              newDestinationSuggestions = true; //n93
            }

            if(numberOfTripGroupMembers > 1 && !sameDestination){ //n94
              newDestinationSuggestions = true;
            }

            //n82, n83, n84, n85, n86, n87, n88
            if(numberOfTripGroupMembers > 1 && newPickupSuggestions){

              // Helper function to get pickup suggestions
                async function getPickupSuggestions(tripGroupMembers: TripGroupMember[], nptTrip: Trip): Promise<PickupLocationSuggestion[]> {
                    // Placeholder for center and radius logic (n83 and n84)
                    // This is complex and will need to be implemented according to your specific requirements
                    // Here's a SIMPLIFIED example for demonstration purposes only, which DOES NOT handle all cases:

                    // Combine all member pickup locations (including NPT).
                    const allPickupLocations: LatLng[] = [];
                    for (const member of tripGroupMembers) {
                        const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                        if(!memberTrip){
                          logger.warn(`Member trip not found for ${member.trip_ref.id}`);
                          continue
                        }
                        allPickupLocations.push(memberTrip.pickup_latlng);
                    }
                    allPickupLocations.push(nptTrip.pickup_latlng);  // Include NPT


                    let center: LatLng;
                    let radius: number;

                    // Calculate the centroid (average) of the pickup locations
                    if(allPickupLocations.length > 0){
                        let sumLat = 0;
                        let sumLng = 0;
                        for (const location of allPickupLocations) {
                            sumLat += location.lat;
                            sumLng += location.lng;
                        }
                        center = { lat: sumLat / allPickupLocations.length, lng: sumLng / allPickupLocations.length };

                        // Calculate the maximum distance from the centroid to any pickup location.
                        let maxDistance = 0;
                        for (const location of allPickupLocations) {
                            const distance = distanceBetween(center, location);
                            maxDistance = Math.max(maxDistance, distance);
                        }

                        radius = Math.min(maxDistance * 1.5, MAX_RADIUS); // Add some buffer, but limit to MAX_RADIUS

                    } else {
                      //default values if something goes wrong
                        center = {lat: 0, lng: 0};
                        radius = 1000;
                    }

                    // Make Nearby Search API call (n85)
                    const apiKey = 'YOUR_API_KEY';
                    const nearbySearchUrl = 'https://places.googleapis.com/v1/places:searchNearby';
                    const headers = {
                        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
                        'X-Goog-Api-Key': apiKey,
                    };

                    const body = {
                        excludedPrimaryTypes: ['administrative_area_level_1'],
                        locationRestriction: {
                            circle: {
                                center: { latitude: center.lat, longitude: center.lng },
                                radius: radius,
                            },
                        },
                    };

                    const response = await fetch(nearbySearchUrl, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(body),
                    });

                    if (!response.ok) {
                      logger.error(`Nearby Search API call failed with status ${response.status}: ${response.statusText}`, { response: await response.text() });
                      throw new HttpsError('internal', `Nearby Search API call failed with status: ${response.status}`);
                    }

                    const nearbySearchResults: MapsNearbySearchResult = await response.json();

                    // Filter and process results (n86, n87, n88).
                    const pickupSuggestions: PickupLocationSuggestion[] = [];
                    if(!nearbySearchResults || !nearbySearchResults.places){ //check for valid results
                      logger.warn("Invalid nearby search results", nearbySearchResults);
                      return []; //no suggestions made
                    }

                    const placeIds = nearbySearchResults.places.map(place => `place_id:${place.displayName.text}`).join(',');
                    const origins = allPickupLocations.map(loc => `${loc.lat},${loc.lng}`).join('|');
                    const distanceMatrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${placeIds}&key=${apiKey}&units=metric&mode=walking`; //n86

                    const distanceMatrixResponse = await fetch(distanceMatrixUrl);
                    if (!distanceMatrixResponse.ok) {
                        logger.error(`Distance Matrix API call failed with status ${distanceMatrixResponse.status}`);
                        throw new HttpsError('internal', 'Distance Matrix API call failed');
                    }

                    const distanceMatrixResult: DistanceMatrixResult = await distanceMatrixResponse.json();
                    
                    // Check if Distance Matrix API call was successful
                    if (distanceMatrixResult.rows.length === 0) {
                        logger.warn("Distance matrix result has no rows", {distanceMatrixResult});
                        return []; // No suggestions
                    }

                    //n86 Filter pickup suggestions within each trip's radius
                    const filteredPlaces: { displayName: { text: string }, formattedAddress: string, location: { latitude: number, longitude: number } }[] = [];
                    for (let i = 0; i < allPickupLocations.length; i++) { //loop through trip pickup locations
                        const tripPickupLocation = allPickupLocations[i];
                        
                        const member = tripGroupMembers[i]; //use tripGroupMembers to get member data
                        if(!member){
                          continue;
                        }
                        const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                        if(!memberTrip){
                          logger.warn(`Member trip is null for trip ID: ${member.trip_ref.id}`);
                          continue
                        }
                        const tripRadius = memberTrip.pickup_radius;

                        //use the distance gotten from distance matrix to filter
                        for (let j = 0; j < nearbySearchResults.places.length; j++) { //loop through pickup suggestions
                          const place = nearbySearchResults.places[j];
                          const distanceElement = distanceMatrixResult.rows[i].elements[j];
                          if (distanceElement.status === "OK" && distanceElement.distance.value <= tripRadius) {
                            if(!filteredPlaces.some(fp => fp.displayName.text === place.displayName.text)){ //prevent duplicate additions
                              filteredPlaces.push(place);
                            }
                          }
                        }
                    }

                    //n87 find most central destination
                    const destinationDistances = new Map<LatLng, number[]>(); //key would be a trip, and the value would be the distances from it to the other trips
                    for(let i = 0; i < tripGroupMembers.length; i++){
                        const tripGroupMember = tripGroupMembers[i];
                        const tripGroupMemberTrip = (await transaction.get(tripGroupMember.trip_ref)).data() as Trip;
                        if(!tripGroupMemberTrip){
                          logger.warn("Trip not found")
                          continue;
                        }
                        const distancesToOtherDestinations = [];

                        for(let j = 0; j < tripGroupMembers.length; j++){
                            if(i != j){ //its not the member itself
                              const otherTripGroupMember = tripGroupMembers[j];
                              const otherTripGroupMemberTrip = (await transaction.get(otherTripGroupMember.trip_ref)).data() as Trip;

                              if(!otherTripGroupMemberTrip){
                                logger.warn("Trip not found");
                                continue
                              }

                              distancesToOtherDestinations.push(distanceBetween(tripGroupMemberTrip.destination_latlng, otherTripGroupMemberTrip.destination_latlng))
                            }
                        }
                        destinationDistances.set(tripGroupMemberTrip.destination_latlng, distancesToOtherDestinations);
                    }

                    //Find the worst-case distance: For each user’s destination, look at all the distances to the others and pick the biggest one.
                    const worstCaseDistances = new Map<LatLng, number>();
                    for (const [destination, distances] of destinationDistances) {
                        const maxDistance = Math.max(...distances);
                        worstCaseDistances.set(destination, maxDistance);
                    }
                    
                    //Pick the smallest worst-case: Compare those biggest distances across all users. Choose the destination where this biggest distance is the smallest. That’s your most central destination.
                    let mostCentralDestination: LatLng = {lat: 0, lng: 0};
                    let smallestWorstCaseDistance = Infinity;
                    for (const [destination, worstCaseDistance] of worstCaseDistances) {
                        if (worstCaseDistance < smallestWorstCaseDistance) {
                            smallestWorstCaseDistance = worstCaseDistance;
                            mostCentralDestination = destination;
                        }
                    }

                    //Another distance matrix API call to find the distances between the pickup suggestions and the most central destination, with the pickup suggestions as origins and the most central destination as destinations
                    const origins2 = filteredPlaces.map(place => `${place.location.latitude},${place.location.longitude}`).join('|');
                    const destinations2 = `${mostCentralDestination.lat},${mostCentralDestination.lng}`;
                    const distanceMatrixUrl2 = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins2}&destinations=${destinations2}&key=${apiKey}&units=metric&mode=driving`; //n87 driving

                    const distanceMatrixResponse2 = await fetch(distanceMatrixUrl2);
                    if (!distanceMatrixResponse2.ok) {
                      logger.error(`Distance Matrix API (2) call failed with status ${distanceMatrixResponse2.status}`);
                      throw new HttpsError('internal', 'Distance Matrix API (2) call failed');
                    }

                    const distanceMatrixResult2 = await distanceMatrixResponse2.json() as DistanceMatrixResult;
                    
                    if(!distanceMatrixResult2 || !distanceMatrixResult2.rows || distanceMatrixResult2.rows.length === 0){
                      logger.warn("No results from distance matrix 2");
                      return [];
                    }

                    //Order the pickup suggestions from the closest to the most central trip destination to the farthest.
                    const sortedPlaces = filteredPlaces.map((place, index) => { //map to add distance and then sort by distance
                        const distanceElement = distanceMatrixResult2.rows[index].elements[0]; //should only have one destination
                        return {
                            place: place,
                            distance: distanceElement.status === "OK" ? distanceElement.distance.value : Infinity,
                        };
                    }).sort((a, b) => a.distance - b.distance);

                    const top3Places = sortedPlaces.slice(0, 3); //top 3 after sorting

                    //n88
                    for (const sortedPlace of top3Places) { //n88
                      const place = sortedPlace.place;
                        const suggestion: PickupLocationSuggestion = {
                            pickup_suggestion_name: place.displayName.text,
                            pickup_suggestion_address: place.formattedAddress,
                            pickup_suggestion_location: { lat: place.location.latitude, lng: place.location.longitude },
                            distances_from_trip_pickup_locations: [],
                            pickup_suggestion_voters: [],
                        };

                        //populate the distances from trip pickup locations
                        for(let i = 0; i < tripGroupMembers.length; i++){
                            const member = tripGroupMembers[i];
                            const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                            if(!memberTrip){
                              logger.warn(`Member trip not found for trip ID: ${member.trip_ref.id}`)
                              continue
                            }

                            const distanceElement = distanceMatrixResult.rows[i].elements[sortedPlaces.findIndex(sp => sp.place.displayName.text === place.displayName.text)];
                            if (distanceElement.status === "OK") {
                              suggestion.distances_from_trip_pickup_locations.push({
                                  trip_id: memberTrip.trip_id,
                                  walking_distance: distanceElement.distance.value,
                              });
                            }
                        }

                      //add the NPT to the distances from trip pickup locations
                        suggestion.distances_from_trip_pickup_locations.push({
                            trip_id: nptTrip.trip_id,
                            walking_distance: distanceBetween(nptTrip.pickup_latlng, { lat: place.location.latitude, lng: place.location.longitude }),
                        });

                        pickupSuggestions.push(suggestion);
                    }
                    return pickupSuggestions;
                }

                const pickupSuggestions = await getPickupSuggestions([...choiceTripGroup.trip_group_members], nptTrip); // Include NPT

                // Add new elements to the choiceTripGroup document.
                const choiceTripGroupUpdateForPickup: Partial<TripGroup> = {};
                choiceTripGroupUpdateForPickup.pickup_location_suggestions = FieldValue.arrayUnion(...pickupSuggestions) as any;
                transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForPickup);
            }


            //n95, n96, n97, n98, n99, n100, n101
            if(numberOfTripGroupMembers > 1 && newDestinationSuggestions){
                // Helper function to get pickup suggestions
                async function getDestinationSuggestions(tripGroupMembers: TripGroupMember[], nptTrip: Trip): Promise<DestinationSuggestion[]> {

                  // Placeholder for center and radius logic (n96 and n97)
                    // This is complex and will need to be implemented according to your specific requirements
                    // Here's a SIMPLIFIED example for demonstration purposes only, which DOES NOT handle all cases:

                    // Combine all member pickup locations (including NPT).
                    const allDestinationLocations: LatLng[] = [];
                    for (const member of tripGroupMembers) {
                        const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
                        if(!memberTrip){
                          logger.warn(`Member trip not found for ID: ${member.trip_ref.id}`);
                          continue
                        }
                        allDestinationLocations.push(memberTrip.destination_latlng);
                    }
                    allDestinationLocations.push(nptTrip.destination_latlng);  // Include NPT


                    let center: LatLng;
                    let radius: number;

                    if(allDestinationLocations.length > 0){
                        // Calculate the centroid (average) of the pickup locations
                        let sumLat = 0;
                        let sumLng = 0;
                        for (const location of allDestinationLocations) {
                            sumLat += location.lat;
                            sumLng += location.lng;
                        }
                        center = { lat: sumLat / allDestinationLocations.length, lng: sumLng / allDestinationLocations.length };

                        // Calculate the maximum distance from the centroid to any pickup location.
                        let maxDistance = 0;
                        for (const location of allDestinationLocations) {
                            const distance = distanceBetween(center, location);
                            maxDistance = Math.max(maxDistance, distance);
                        }

                        radius = Math.min(maxDistance * 1.5, MAX_RADIUS); //limit to max radius

                    } else {
                        center = {lat: 0, lng: 0};
                        radius = 1000;
                    }


                    // Make Nearby Search API call (n101)
                    const apiKey = 'YOUR_API_KEY';
                    const nearbySearchUrl = 'https://places.googleapis.com/v1/places:searchNearby'; //n101
                    const headers = {
                        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location', //n101
                        'X-Goog-Api-Key': apiKey,
                    };

                    const body = {
                        excludedPrimaryTypes: ['administrative_area_level_1'],
                        locationRestriction: {
                            circle: {
                                center: { latitude: center.lat, longitude: center.lng },
                                radius: radius,
                            },
                        },
                    };
                    
                    const response = await fetch(nearbySearchUrl, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(body),
                    });

                    if (!response.ok) {
                        logger.error(`Nearby Search API call failed with status ${response.status}`);
                        throw new HttpsError('internal', 'Nearby Search API call failed');
                    }

                    const nearbySearchResults: MapsNearbySearchResult = await response.json();

                    // Filter and process results (n99, n100, n98).
                    const destinationSuggestions: DestinationSuggestion[] = [];
                    if(!nearbySearchResults || !nearbySearchResults.places){ //check for valid results
                      logger.warn("Invalid nearby search results", nearbySearchResults);
                      return [];
                    }

                    //n100
                    const placeIds = nearbySearchResults.places.map(place => `place_id:${place.displayName.text}`).join(','); //n100
                    const origins = allDestinationLocations.map(loc => `${loc.lat},${loc.lng}`).join('|');
                    const distanceMatrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${placeIds}&key=${apiKey}&units=metric&mode=walking`; //n100

                    const distanceMatrixResponse = await fetch(distanceMatrixUrl);
                    if (!distanceMatrixResponse.ok) {
                        logger.error(`Distance Matrix API call failed with status ${distanceMatrixResponse.status}`);
                        throw new HttpsError('internal', 'Distance Matrix API call failed');
                    }

                    const distanceMatrixResult: DistanceMatrixResult = await distanceMatrixResponse.json();

                    if(!distanceMatrixResult || !distanceMatrixResult.rows || distanceMatrixResult.rows.length === 0){
                      logger.warn("No results from distance matrix");
                      return []
                    }

                    // Filter destination suggestions within each trip's radius
                    const filteredPlaces: { displayName: { text: string }, formattedAddress: string, location: { latitude: number, longitude: number } }[] = [];
                    for (let i = 0; i < allDestinationLocations.length; i++) {
                        const tripDestinationLocation = allDestinationLocations[i];
                        const member = tripGroupMembers[i];
                        if(!member){
                          continue
                        }
                        const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                        if(!memberTrip){
                          logger.warn(`Member trip not found for trip ID: ${member.trip_ref.id}`);
                          continue
                        }
                        const tripRadius = memberTrip.destination_radius;

                        for (let j = 0; j < nearbySearchResults.places.length; j++) {
                          const place = nearbySearchResults.places[j];
                          const distanceElement = distanceMatrixResult.rows[i].elements[j];
                          if (distanceElement.status === "OK" && distanceElement.distance.value <= tripRadius) {
                            if(!filteredPlaces.some(fp => fp.displayName.text === place.displayName.text)){ //prevent duplicate additions
                              filteredPlaces.push(place);
                            }
                          }
                        }
                    }

                    //find most central pickup location n99
                    const pickupDistances = new Map<LatLng, number[]>();
                    for(let i = 0; i < tripGroupMembers.length; i++){
                        const tripGroupMember = tripGroupMembers[i];
                        const tripGroupMemberTrip = (await transaction.get(tripGroupMember.trip_ref)).data() as Trip;

                        if(!tripGroupMemberTrip){
                          logger.warn("Trip not found");
                          continue
                        }

                        const distancesToOtherPickups = [];
                        for(let j = 0; j < tripGroupMembers.length; j++){
                            if(i != j){ //its not the trip itself
                              const otherTripGroupMember = tripGroupMembers[j];
                              const otherTripGroupMemberTrip = (await transaction.get(otherTripGroupMember.trip_ref)).data() as Trip;
                              if(!otherTripGroupMemberTrip){
                                logger.warn("Trip not found")
                                continue
                              }
                              distancesToOtherPickups.push(distanceBetween(tripGroupMemberTrip.pickup_latlng, otherTripGroupMemberTrip.pickup_latlng))
                            }
                        }
                        pickupDistances.set(tripGroupMemberTrip.pickup_latlng, distancesToOtherPickups);
                    }

                    //Find the worst-case distance: For each user’s destination, look at all the distances to the others and pick the biggest one.
                    const worstCaseDistances = new Map<LatLng, number>();
                    for (const [pickupLocation, distances] of pickupDistances) {
                        const maxDistance = Math.max(...distances);
                        worstCaseDistances.set(pickupLocation, maxDistance);
                    }

                    //Pick the smallest worst-case: Compare those biggest distances across all users. Choose the destination where this biggest distance is the smallest. That’s your most central destination.
                    let mostCentralPickupLocation: LatLng = {lat: 0, lng: 0};
                    let smallestWorstCaseDistance = Infinity;

                    for (const [pickupLocation, worstCaseDistance] of worstCaseDistances) {
                        if (worstCaseDistance < smallestWorstCaseDistance) {
                            smallestWorstCaseDistance = worstCaseDistance;
                            mostCentralPickupLocation = pickupLocation;
                        }
                    }

                    //Another distance matrix API call to find the distances between the most central pickup location and the destination suggestions
                    const origins2 = `${mostCentralPickupLocation.lat},${mostCentralPickupLocation.lng}`;
                    const destinations2 = filteredPlaces.map(place => `${place.location.latitude},${place.location.longitude}`).join('|');
                    const distanceMatrixUrl2 = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins2}&destinations=${destinations2}&key=${apiKey}&units=metric&mode=driving`; //n99 driving

                    const distanceMatrixResponse2 = await fetch(distanceMatrixUrl2);
                    if (!distanceMatrixResponse2.ok) {
                        logger.error(`Distance Matrix API (2) call failed with status ${distanceMatrixResponse2.status}`);
                        throw new HttpsError('internal', 'Distance Matrix API (2) call failed');
                    }

                    const distanceMatrixResult2 = await distanceMatrixResponse2.json() as DistanceMatrixResult;

                    if(!distanceMatrixResult2 || !distanceMatrixResult2.rows || distanceMatrixResult2.rows.length === 0){
                      logger.warn("No results from distance matrix 2");
                      return []
                    }

                    //Order the destination suggestions from the closest to the most central pickup location to the farthest.
                    const sortedPlaces = filteredPlaces.map((place, index) => {
                      const distanceElement = distanceMatrixResult2.rows[0].elements[index]; // 0 because there is only 1 origin
                      return {
                        place: place,
                        distance: distanceElement.status === "OK" ? distanceElement.distance.value: Infinity,
                      }
                    }).sort((a, b) => a.distance - b.distance);
                    
                    const top3Places = sortedPlaces.slice(0, 3);

                    //n98
                    for (const sortedPlace of top3Places) {
                        const place = sortedPlace.place;
                        const suggestion: DestinationSuggestion = {
                            destination_suggestion_name: place.displayName.text,
                            destination_suggestion_address: place.formattedAddress,
                            destination_suggestion_location: { lat: place.location.latitude, lng: place.location.longitude },
                            distances_from_trip_destinations: [],
                            destination_suggestion_voters: [],
                        };

                        //populate distances from trip destination locations
                        for(let i = 0; i < tripGroupMembers.length; i++){
                            const member = tripGroupMembers[i];
                            const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;

                            if(!memberTrip){
                              logger.warn(`Member trip not found for trip ID: ${member.trip_ref.id}`)
                              continue
                            }
                            const distanceElement = distanceMatrixResult.rows[i].elements[sortedPlaces.findIndex(sp => sp.place.displayName.text === place.displayName.text)];
                            if(distanceElement.status === "OK"){
                              suggestion.distances_from_trip_destinations.push({
                                trip_id: memberTrip.trip_id,
                                walking_distance: distanceElement.distance.value
                              });
                            }
                        }

                      //add the NPT to distances from trip destinations
                        suggestion.distances_from_trip_destinations.push({
                            trip_id: nptTrip.trip_id,
                            walking_distance: distanceBetween(nptTrip.destination_latlng, { lat: place.location.latitude, lng: place.location.longitude }),
                        });

                        destinationSuggestions.push(suggestion);
                    }

                    return destinationSuggestions;
                }

                const destinationSuggestions = await getDestinationSuggestions([...choiceTripGroup.trip_group_members], nptTrip);

                // Add new elements to the choiceTripGroup document.
                const choiceTripGroupUpdateForDestination: Partial<TripGroup> = {};
                choiceTripGroupUpdateForDestination.destination_suggestions = FieldValue.arrayUnion(...destinationSuggestions) as any;
                transaction.update(choiceTripGroupRef, choiceTripGroupUpdateForDestination);
            }


            //n102, n103, n105, n106
            const choiceTripGroupMembersBeforeNPT = choiceTripGroup.trip_group_members; //n103

            //get array union of time_range_arrays
            const timeRangeArraysBeforeNPT: string[][] = []; //n103
            for(const member of choiceTripGroupMembersBeforeNPT){
              const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
              if(!memberTrip){
                logger.warn("Member trip not found");
                continue
              }
              timeRangeArraysBeforeNPT.push(memberTrip.time_range_array);
            }
            const unionBeforeNPT = [...new Set(timeRangeArraysBeforeNPT.flat())];

            const timeRangeArraysIncludingNPT: string[][] = []; //n103
            for(const member of [...choiceTripGroup.trip_group_members, newTripGroupMember]){
              const memberTrip = (await transaction.get(member.trip_ref)).data() as Trip;
              if(!memberTrip){
                logger.warn("Member trip not found");
                continue;
              }
                timeRangeArraysIncludingNPT.push(memberTrip.time_range_array);
            }
            const unionIncludingNPT = [...new Set(timeRangeArraysIncludingNPT.flat())];
                
            //Length of array union of the time_range_array field of all members of choice trip group prior to NPT entry > Length of array union of the time_range_array field of all members of choice trip group including the NPT?
            if (unionBeforeNPT.length > unionIncludingNPT.length) { //n103
                timeArrayChanged = true; //n106
            }
            
            //n105
            if (timeArrayChanged) {
              const formatDateTo12Hour = (dateString: string): string => {
                try {
                  const date = new Date(dateString);

                  // Check if the date is valid
                  if (isNaN(date.getTime())) {
                    throw new Error("Invalid date string");
                  }

                  let hours = date.getHours();
                  const minutes = date.getMinutes();
                  const ampm = hours >= 12 ? 'PM' : 'AM';
                  hours = hours % 12;
                  hours = hours ? hours : 12; // the hour '0' should be '12'
                  const minutesStr = minutes < 10 ? '0' + minutes : minutes;
                  let strTime = hours + ':' + minutesStr + ' ' + ampm;

                  // Check if it's the same day as the first element
                  if (unionIncludingNPT.length > 0) {
                      const firstDate = new Date(unionIncludingNPT[0]);
                      if (date.toDateString() !== firstDate.toDateString()) {
                          strTime += ' (Next day)';
                      }
                  }

                  return strTime;
                } catch (error) {
                  logger.error("Error formatting date:", {dateString, error});
                  return "Invalid Date"; // Or some other placeholder
                }
              }

              tripGroupTimeRangeArray = unionIncludingNPT.map(dateString => formatDateTo12Hour(dateString)); //n105
            }

            //n104, and notification placeholders
            const messageRef = choiceTripGroupRef.collection('messages').doc();

            const message: Message = { //n104
                message_type: 'system',
                user_ref: nptTripRef.parent.parent!,
                message: `[${userData.first_name}] joined the trip group`, //n104
                timestamp: Timestamp.now(),
                seenBy: [],
                newly_paid_trip_ref: nptTripRef,
                redundant: false,
                first_name: userData.first_name,
                last_name: userData.last_name,
                system_message: true,
                new_pickup_suggestion: newPickupSuggestions, //n104
                new_destination_suggestion: newDestinationSuggestions, //n104
                group_time_range_array_changed: timeArrayChanged, //n104
                group_time_range_array: tripGroupTimeRangeArray, //n104
            };
            transaction.set(messageRef, message);

            // Get the remaining TG members (exclude NPT)
            const remainingTGMembers = choiceTripGroup.trip_group_members.filter(member => member.trip_ref.id !== nptTrip.trip_id);

            // Send notifications based on conditions
            if (remainingTGMembers.length > 0) { //check to prevent sending messages when there are no members
              if (!newPickupSuggestions && !newDestinationSuggestions && !timeArrayChanged) { //n107
                  //n108
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. Tap to see details!");
                  // Implement notification sending logic here.
                  // Example (using FCM - Firebase Cloud Messaging):

                  // for (const member of remainingTGMembers) {
                  //   const userRef = member.user_ref;
                  //     const fcmToken = await getUserFCMToken(userRef);  // You'll need a function to retrieve FCM tokens.
                  //   if (fcmToken) {
                  //     await sendNotification(fcmToken, {
                  //         title: "New Trip Member",
                  //         body: `[${userData.first_name}] just joined your trip group. Tap to see details!`,
                  //     });
                  //    }
                  // }

              }else if (!newPickupSuggestions && !newDestinationSuggestions && timeArrayChanged) { //n109

                  if(tripGroupTimeRangeArray.length > 1){ //n110
                    //n112
                    logger.info("Sending notification: [NPT user’s name] just joined your trip group. Trip departure time is now set for [first element of tripGroupTimeRangeArray] - [last element of tripGroupTimeRangeArray]. Tap to see details!");
                    // ... notification logic ...
                  } else {
                    //n111
                    logger.info("Sending notification: [NPT user’s name] just joined your trip group. Trip departure time is now set for [first element of tripGroupTimeRangeArray]. Tap to see details!");
                  }

              } else if (!newPickupSuggestions && newDestinationSuggestions && !timeArrayChanged) { //n113
                //n114
                logger.info("Sending notification: [NPT user’s name] just joined your trip group. New drop-off suggestions to vote on. Tap to see details!");
                  // ... notification logic ...

              } else if (!newPickupSuggestions && newDestinationSuggestions && timeArrayChanged) { //n115
                if(tripGroupTimeRangeArray.length > 1){ //n116
                  //n118
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New drop-off suggestions to vote on. Trip departure time is now set for [first element of tripGroupTimeRangeArray] - [last element of tripGroupTimeRangeArray]. Tap to see details!");

                } else {
                  //n117
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New drop-off suggestions to vote on. Trip departure time is now set for [first element of tripGroupTimeRangeArray]. Tap to see details!");
                }
              } else if (newPickupSuggestions && !newDestinationSuggestions && !timeArrayChanged) { //n119
                //n120
                logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup suggestions to vote on. Tap to see details!");
                // ... notification logic ...

              } else if (newPickupSuggestions && !newDestinationSuggestions && timeArrayChanged) { //n121
                if(tripGroupTimeRangeArray.length > 1){ //n122
                  //n124
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup suggestions to vote on. Trip departure time is now set for [first element of tripGroupTimeRangeArray] - [last element of tripGroupTimeRangeArray]. Tap to see details!");
                } else {
                  //n123
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup suggestions to vote on. Trip departure time is now set for [last element of tripGroupTimeRangeArray]. Tap to see details!");
                }

              } else if (newPickupSuggestions && newDestinationSuggestions && !timeArrayChanged) { //n125
                //n126
                logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup and drop-off suggestions to vote on. Tap to see details!");
                // ... notification logic ...

              } else if (newPickupSuggestions && newDestinationSuggestions && timeArrayChanged) { //n102 (i)
                if(tripGroupTimeRangeArray.length > 1){ //n127
                  //n128
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup and drop-off suggestions to vote on. Trip departure time is now set for [first element of tripGroupTimeRangeArray] - [last element of tripGroupTimeRangeArray]. Tap to see details!");

                } else {
                  //n129
                  logger.info("Sending notification: [NPT user’s name] just joined your trip group. New meetup and drop-off suggestions to vote on. Trip departure time is now set for [last element of tripGroupTimeRangeArray]. Tap to see details!");
                }

              }
            } //end of notification placeholders
    }); //end of transaction
    //n75
    logger.info("Transaction completed successfully");

    } catch (error) {
        logger.error("Error in tripPaid:", error);  // Log the error.
        if (error instanceof HttpsError) {
            throw error; // Re-throw explicit HttpsErrors.
        }
        throw new HttpsError("internal", "An unexpected error occurred.", error);  // Generic error.
    }
});


/**
 * Calculates the distance in meters between two LatLng points using the Haversine formula.
 */
function distanceBetween(coord1: LatLng, coord2: LatLng): number {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = coord1.lat * Math.PI / 180;
  const φ2 = coord2.lat * Math.PI / 180;
  const Δφ = (coord2.lat - coord1.lat) * Math.PI / 180;
  const Δλ = (coord2.lng - coord1.lng) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = R * c;
  return distance;
}
