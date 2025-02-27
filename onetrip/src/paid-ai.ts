import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { Timestamp, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase-admin/app';
import {
    User,
    Trip,
    MatchedTrip,
    PotentialTrip,
    LatLng,
    TripGroup,
    TripGroupMember,
    RecentMessage,
    PotentialTripMember,
    ObstructingTripMember,
    PickupLocationSuggestion,
    DestinationSuggestion,
    DistanceFromLocation,
    Message,
    TripGroupInfo,
    MatchedTripToBeAdded,
    PotentialTripToBeAdded
} from '../../type'; // Import your types

initializeApp();
const db = getFirestore();


// Helper function to calculate overlap gap (implementation needed)
function calculatePickupOverlapGap(trip1: Trip, trip2: Trip): number {
    // Implement your logic to calculate the pickup overlap gap.
    // This likely involves comparing trip1.pickup_latlng and trip2.pickup_latlng
    // and considering trip1.pickup_radius and trip2.pickup_radius.
    // Return the calculated gap (not distance).
    return 0; // Replace with actual calculation
}

function calculateDestinationOverlapGap(trip1: Trip, trip2: Trip): number {
    // Implement your logic for destination overlap gap.
    return 0; // Replace with actual calculation
}


export const tripPaidFunction = onDocumentUpdated('trips/{tripId}', async (event) => {
    // @ts-ignore
    const nptBefore = event.data.before.data() as Trip;
    // @ts-ignore
    const nptAfter = event.data.after.data() as Trip;

    // Check if the 'status' field changed to 'paid'
    if (nptBefore.status === 'paid' || nptAfter.status !== 'paid') {
        return; // Exit if status didn't change to 'paid'
    }

    const nptRef = event.data.after.ref;

    try {
        await db.runTransaction(async (transaction) => {
            // 1. Get the updated NPT data WITHIN the transaction.
            const npt = (await transaction.get(nptRef)).data() as Trip;
            if (!npt) {
                console.error("NPT document not found!");
                return;
            }
             
            let choiceTripGroupRef: FirebaseFirestore.DocumentReference | null = null;


            if (npt.reserved) {
                // NPT is reserving another trip
                const reservingTripRef = db.collection('trips').doc(npt.reserving_trip_id);
                const reservingTripDoc = await transaction.get(reservingTripRef);
                const reservingTrip = reservingTripDoc.data() as Trip;

                if (!reservingTrip) {
                    console.error("Reserving trip not found for NPT:", npt.trip_id);
                    return;  // Or throw an error, depending on how you want to handle this
                }

                const choiceTripGroupSnapshot = await transaction.get(db.collection('tripGroups').doc(reservingTrip.trip_group_id));
                const choiceTripGroup = choiceTripGroupSnapshot.data() as TripGroup;

                if (!choiceTripGroup) {
                    console.error("choiceTripGroup not found for trip:", reservingTrip.trip_id);
                    return;
                }

                // Update NPT Document
                transaction.update(nptRef, {
                    trip_group_id: choiceTripGroup.trip_group_id,
                    total_seat_count: choiceTripGroup.total_seat_count + npt.seat_count,
                    reserved: false,
                    reserving_trip_id: FieldValue.delete(),
                });

                // Update NPT's reserving trip's document
                transaction.update(reservingTripRef, {
                  total_seat_count: choiceTripGroup.total_seat_count + npt.seat_count,
                });

                //Update the element in reserving trip's matched_trips containing NPT
                const updatedMatchedTrips: MatchedTrip[] = reservingTrip.matched_trips.map(mt => {
                  if (mt.trip_id === npt.trip_id) {
                    return {
                      ...mt,
                      total_seat_count: choiceTripGroup.total_seat_count + npt.seat_count,
                      paid: true,
                      trip_group_id: choiceTripGroup.trip_group_id,
                      reserving: false
                    };
                  }
                  return mt;
                });

                transaction.update(reservingTripRef, {
                  matched_trips: updatedMatchedTrips
                });
            } else {
                // NPT is not reserving another trip

                // Check for Paid Matched Trips
                const paidMatchedTrips = npt.matched_trips.filter(mt => mt.paid);

                if (paidMatchedTrips.length > 0) {
                    // Extract Distinct Trip Groups
                    const distinctTripGroupIds = [...new Set(paidMatchedTrips.map(mt => mt.trip_group_id))];

                    if (distinctTripGroupIds.length === 1) {
                      const tripGroupId = distinctTripGroupIds[0];
                      if (tripGroupId) {
                        choiceTripGroupRef = db.collection('tripGroups').doc(tripGroupId);
                        const choiceTripGroupDoc = await transaction.get(choiceTripGroupRef);
                        const choiceTripGroup = choiceTripGroupDoc.data() as TripGroup;

                        if (!choiceTripGroup) {
                            console.error("choiceTripGroup not found for trip:", npt.trip_id);
                            return;
                        }


                        // Update NPT Document
                        transaction.update(nptRef, {
                          trip_group_id: choiceTripGroup.trip_group_id,
                          total_seat_count: choiceTripGroup.total_seat_count + npt.seat_count,
                        });

                        if (choiceTripGroup.trip_group_members.length === 1) {
                          // Sole Trip Group Member Logic
                          const soleMember = choiceTripGroup.trip_group_members[0];
                          const soleMemberTripRef = db.collection('trips').doc(soleMember.trip_id);
                          const soleMemberTripDoc = await transaction.get(soleMemberTripRef);
                          const soleMemberTrip = soleMemberTripDoc.data() as Trip;

                          if (!soleMemberTrip) {
                            console.error("Sole member trip not found:", soleMember.trip_id);
                            return; // Handle error as needed
                          }

                          let reservingTripRefForSoleMember: FirebaseFirestore.DocumentReference | null = null;
                          let reservingTripForSoleMember: Trip | null = null;
                          let indexOfSoleMemberReservingTrip = -1;

                          for (let i = 0; i < soleMemberTrip.matched_trips.length; i++) {
                            if (soleMemberTrip.matched_trips[i].reserving) {
                              reservingTripRefForSoleMember = db.collection('trips').doc(soleMemberTrip.matched_trips[i].trip_id);
                              indexOfSoleMemberReservingTrip = i;
                              const temp = await transaction.get(reservingTripRefForSoleMember);
                              reservingTripForSoleMember = temp.data() as Trip;
                              break;
                            }
                          }


                          if (!reservingTripRefForSoleMember || !reservingTripForSoleMember) {
                            console.error("Reserving trip of sole member not found");
                            return;
                          }

                          //Update sole member
                          const updatedSoleMemberMatchedTrips = soleMemberTrip.matched_trips.map((trip) => {
                            if (trip.reserving) {
                              return { ...trip, reserving: false };
                            }
                            return trip;
                          });

                          transaction.update(soleMemberTripRef, {
                            matched_trips: updatedSoleMemberMatchedTrips
                          });

                          //Update trip being reserved by sole member
                          transaction.update(reservingTripRefForSoleMember, {
                            reserved: false,
                            reserving_trip_id: FieldValue.delete()
                          });


                          //From reserving trip, get all matched trips with mutual as true and potential trips with mutual as false
                          const mutualMatchedTrips = reservingTripForSoleMember.matched_trips.filter(trip => trip.mutual);
                          const nonMutualPotentialTrips = reservingTripForSoleMember.potential_trips.filter(trip => !trip.mutual);

                          const combinedTrips: (PotentialTrip | MatchedTrip)[] = [...mutualMatchedTrips, ...nonMutualPotentialTrips];

                          //Get trips that have reserving_trip_obstruction and proper_match
                          const reservingTripObstructionTrips: Trip[] = [];
                          const properMatchReservingTripObstructionTrips: Trip[] = [];
                          //let index = -1;
                          const tripPromises = combinedTrips.map(async (combinedTrip) => {
                            const tripRef = db.collection('trips').doc(combinedTrip.trip_id);
                            const tripDoc = await transaction.get(tripRef);
                            const trip = tripDoc.data() as Trip;

                            if (!trip) {
                              console.error("Trip not found in combined trips:", combinedTrip.trip_id);
                              return;  // Continue to the next iteration.
                            }

                            const index = trip.potential_trips.findIndex(
                              (potentialTrip) => potentialTrip.trip_id === reservingTripForSoleMember?.trip_id
                            );

                            if (index !== -1) {
                              if (trip.potential_trips[index].reserving_trip_obstruction && !trip.potential_trips[index].proper_match) {
                                reservingTripObstructionTrips.push(trip);
                              } else if (trip.potential_trips[index].reserving_trip_obstruction && trip.potential_trips[index].proper_match) {
                                properMatchReservingTripObstructionTrips.push(trip);
                              }
                            }
                          });

                          await Promise.all(tripPromises); // Make sure all trip data is fetched.



                          //Update all the trips in reserving_trip_obstruction_trips
                          for (const trip of reservingTripObstructionTrips) {
                            const tripRef = db.collection('trips').doc(trip.trip_id);
                            // Find index within the transaction
                            const index = trip.potential_trips.findIndex(pt => pt.trip_id === reservingTripForSoleMember?.trip_id);
                            if (index > -1) {

                              const updatedPotentialTrips = [...trip.potential_trips]; // Create a copy
                              updatedPotentialTrips[index] = {
                                ...updatedPotentialTrips[index],  // Copy existing fields
                                reserving_trip_obstruction: false
                              };

                              transaction.update(tripRef, {
                                potential_trips: updatedPotentialTrips
                              });
                            }
                          }


                          //Update all the trips in proper_match_reserving_trip_obstruction_trips
                          for (const trip of properMatchReservingTripObstructionTrips) {
                            const tripRef = db.collection('trips').doc(trip.trip_id);
                            // Find index within the transaction
                            const index = trip.potential_trips.findIndex(pt => pt.trip_id === reservingTripForSoleMember?.trip_id);
                            if(index > -1)
                            {
                                 const updatedPotentialTrips = trip.potential_trips.filter(pt => pt.trip_id !== reservingTripForSoleMember?.trip_id);
                            // Prepare matchedTrip to be added
                            const matchedTripToBeAdded: MatchedTrip = {
                              trip_id: reservingTripForSoleMember!.trip_id,
                              trip_group_id: "", // As per your pseudocode
                              paid: false,
                              pickup_radius: reservingTripForSoleMember!.potential_trips[index].pickup_radius,
                              destination_radius: reservingTripForSoleMember!.potential_trips[index].destination_radius,
                              pickup_distance: reservingTripForSoleMember!.potential_trips[index].pickup_distance,
                              destination_distance: reservingTripForSoleMember!.potential_trips[index].destination_distance,
                              mutual: reservingTripForSoleMember!.potential_trips.some(pt => pt.trip_id === trip.trip_id),
                              reserving: false,
                              user_id: reservingTripForSoleMember!.user_id,
                              seat_count: reservingTripForSoleMember!.seat_count,

                            };

                            const updatedMatchedTrips = [...trip.matched_trips, matchedTripToBeAdded];

                            transaction.update(tripRef, {
                              potential_trips: updatedPotentialTrips,
                              matched_trips: updatedMatchedTrips,
                            });
                            }

                           
                          }


                          //Update reserving trip document

                          const tripPromises2 = reservingTripForSoleMember.matched_trips.map(async (matchedTrip) => {
                             if (!matchedTrip.mutual) {
                                  const tripRef = db.collection('trips').doc(matchedTrip.trip_id);
                                  transaction.update(tripRef, {
                                      'matched_trips.$[elem].mutual': true // Use arrayFilters for updates within arrays
                                  }, {
                                      arrayFilters: [{ 'elem.trip_id': matchedTrip.trip_id }]
                                  });
                              }
                          });

                          const tripPromises3 = reservingTripForSoleMember.potential_trips.map(async (potentialTrip) => {
                              if (potentialTrip.mutual) {
                                const tripRef = db.collection('trips').doc(potentialTrip.trip_id);

                                transaction.update(tripRef, {
                                    'potential_trips.$[elem].mutual': false // Use arrayFilters for updates
                                }, {
                                    arrayFilters: [{ 'elem.trip_id': potentialTrip.trip_id }]
                                });
                              }
                          });

                        } else {
                          // Choice TG has more than one member.
                        }
                      }
                    } else {
                      // More than one distinct trip group

                      // Fetch all TripGroups in parallel
                      const tripGroupPromises = distinctTripGroupIds.map(async (groupId) => {
                        const tripGroupRef = db.collection('tripGroups').doc(groupId);
                        const tripGroupDoc = await transaction.get(tripGroupRef);
                        return { ref: tripGroupRef, data: tripGroupDoc.data() as TripGroup };
                      });
                      const tripGroups = await Promise.all(tripGroupPromises);



                      // 1. Calculate Trip Counts for each Trip Group
                      const tripGroupInfos: { group: TripGroup, ref: FirebaseFirestore.DocumentReference, tripCount: number, totalPickupDistance: number, totalDestinationDistance: number }[] = [];

                      for (const group of tripGroups) {
                        if (!group.data) continue;  // Skip if data is null

                        let tripCount = 0;
                        let totalPickupDistance = 0;
                        let totalDestinationDistance = 0;


                        const memberPromises = group.data.trip_group_members.map(async member => {
                          const memberTripRef = db.collection('trips').doc(member.trip_id);
                          const memberTripDoc = await transaction.get(memberTripRef);
                          const memberTrip = memberTripDoc.data() as Trip;

                          if (memberTrip) {
                            tripCount++;  // Increment the trip count

                            // Accumulate distances for matched trips related to the NPT
                            memberTrip.matched_trips.forEach(matchedTrip => {
                              if (matchedTrip.trip_id === npt.trip_id) {
                                totalPickupDistance += matchedTrip.pickup_distance;
                                totalDestinationDistance += matchedTrip.destination_distance;
                              }
                            });
                          }
                        });

                        await Promise.all(memberPromises);
                        tripGroupInfos.push({ group: group.data, ref: group.ref, tripCount, totalPickupDistance, totalDestinationDistance });
                      }


                      // 2. Find Trip Group with Least Trips
                      let smallestTripGroup = tripGroupInfos.reduce((prev, curr) => prev.tripCount < curr.tripCount ? prev : curr);

                      // 3. Check for multiple groups with the same minimum count
                      let leastTripsGroups = tripGroupInfos.filter(groupInfo => groupInfo.tripCount === smallestTripGroup.tripCount);

                      if (leastTripsGroups.length > 1) {
                        // 4. Multiple groups with least trips:  Find group with least total distance
                        let choiceTripGroupInfo = leastTripsGroups.reduce((prev, curr) =>
                          (prev.totalPickupDistance + prev.totalDestinationDistance) < (curr.totalPickupDistance + curr.totalDestinationDistance) ? prev : curr
                        );

                        // 5. Check for multiple groups with the same minimum distance
                        let leastDistanceGroups = leastTripsGroups.filter(groupInfo =>
                          (groupInfo.totalPickupDistance + groupInfo.totalDestinationDistance) === (choiceTripGroupInfo.totalPickupDistance + choiceTripGroupInfo.totalDestinationDistance)
                        );

                        if (leastDistanceGroups.length > 1) {
                          // 6. Multiple groups with least distance: Random Selection
                          choiceTripGroupInfo = leastDistanceGroups[Math.floor(Math.random() * leastDistanceGroups.length)];
                        }
                        // 7. Least distance group is the choice: choice_trip_group already set

                        choiceTripGroupRef = choiceTripGroupInfo.ref;
                        // Update NPT Document
                        transaction.update(nptRef, {
                          trip_group_id: choiceTripGroupInfo.group.trip_group_id,
                          total_seat_count: choiceTripGroupInfo.group.total_seat_count + npt.seat_count,
                        });

                      } else {
                        // 8. Least trips group is the choice
                        choiceTripGroupRef = smallestTripGroup.ref;
                        // Update NPT Document
                        transaction.update(nptRef, {
                          trip_group_id: smallestTripGroup.group.trip_group_id,
                          total_seat_count: smallestTripGroup.group.total_seat_count + npt.seat_count,
                        });
                      }
                    }
                } else {
                    //No paid matched trips for NPT
                    //Create New Trip Group (TG)
                    const newTripGroupRef = db.collection('tripGroups').doc(); // Auto-generate ID
                    const newTripGroupId = newTripGroupRef.id;


                    const newTripGroupMember: TripGroupMember = {
                      trip_id: npt.trip_id,
                      user_id: npt.user_id,
                      first_name: "", // Fetch these from user document if needed
                      last_name: "",
                      phone_number: "",
                      photo_url: "",
                      seat_count: npt.seat_count,
                      joined_timestamp: Timestamp.now(), // Use server timestamp
                      last_message_read_id: "",
                      earliest_date_time: npt.start_date_time,
                      latest_date_time: npt.end_date_time
                    }

                    const userRef = db.collection('users').doc(npt.user_id);
                    const userDoc = await transaction.get(userRef);
                    const user = userDoc.data() as User;
                    if (user) {
                      newTripGroupMember.first_name = user.first_name;
                      newTripGroupMember.last_name = user.last_name;
                      newTripGroupMember.phone_number = user.phone_number;
                      newTripGroupMember.photo_url = user.photo_url;
                    }

                    const newTripGroup: TripGroup = {
                      trip_group_id: newTripGroupId,
                      trip_group_members: [newTripGroupMember],
                      recent_message: {
                        message_id: "",
                        message_type: "",
                        message: "",
                        from_id: "",
                        from_first_name: "",
                        timestamp: Timestamp.now(), // Provide a default value or fetch as needed
                        seenBy: []
                      },  // Initialize, you might want to populate this
                      total_seat_count: npt.seat_count,
                      potential_trip_members: [], // Initialize as empty, we'll populate it below
                      pickup_location_suggestions: [],
                      destination_suggestions: [],
                    };

                    // Add all of NPT's matched and potential trips to potential trip members of the new trip group

                    const combinedTripsForPotential: (MatchedTrip | PotentialTrip)[] = [...npt.matched_trips, ...npt.potential_trips];

                    for (const trip of combinedTripsForPotential) {
                       const potentialTripMember : PotentialTripMember = {
                        trip_id: trip.trip_id,
                        user_id: trip.user_id,
                        obstructing_trip_members: [], // You may need to calculate this,
                        trip_obstruction: false,
                        seat_obstruction: false, //This may also depend on other factors
                        seat_count: npt.seat_count,
                        unknown_trip_obstruction: false,
                       }
                      newTripGroup.potential_trip_members.push(potentialTripMember);
                    }


                    transaction.set(newTripGroupRef, newTripGroup);

                    // Update NPT Document (with new TG)
                    transaction.update(nptRef, {
                      trip_group_id: newTripGroupId,
                      total_seat_count: npt.seat_count
                    });
                  
                  choiceTripGroupRef = newTripGroupRef;

                    //Get all NPT’s matched trips with mutual as true and potential trips with mutual as false  
                    const trueMatchedTrips = npt.matched_trips.filter(trip => trip.mutual);
                    const falsePotentialTrips = npt.potential_trips.filter(trip => !trip.mutual);

                    const combinedTrips = [...trueMatchedTrips, ...falsePotentialTrips];

                  const tripPromises = combinedTrips.map(async (combinedTrip) => {
                        const tripRef = db.collection('trips').doc(combinedTrip.trip_id);
                        const tripDoc = await transaction.get(tripRef);
                        const trip = tripDoc.data() as Trip;

                        if (!trip) {
                          console.error("Trip not found in combined trips (true/false):", combinedTrip.trip_id);
                          return;  // Continue to the next iteration.
                        }

                        // Update matched_trips within the transaction
                    if (trip.matched_trips.length > 0) {
                         const matchedTripIndex = trip.matched_trips.findIndex(mt => mt.trip_id === npt.trip_id);
                        if(matchedTripIndex > -1)
                        {
                              const updatedMatchedTrips = [...trip.matched_trips]; // Create copy
                              updatedMatchedTrips[matchedTripIndex] = {
                                  ...updatedMatchedTrips[matchedTripIndex], // Copy existing
                                  paid: true,
                                  trip_group_id: newTripGroupId
                              }
                              transaction.update(tripRef, { matched_trips: updatedMatchedTrips });

                        }
                    }
                    });

                    await Promise.all(tripPromises);



                    //Get all NPT’s matched trips with mutual as false and potential trips with mutual as true 
                    const falseMatchedTrips = npt.matched_trips.filter(trip => !trip.mutual);
                    const truePotentialTrips = npt.potential_trips.filter(trip => trip.mutual);

                    const otherCombinedTrips = [...falseMatchedTrips, ...truePotentialTrips];


                   const otherTripPromises = otherCombinedTrips.map(async otherCombinedTrip => {
                      const tripRef = db.collection('trips').doc(otherCombinedTrip.trip_id);
                      const tripDoc = await transaction.get(tripRef);
                      const trip = tripDoc.data() as Trip;
                     if (!trip) {
                        console.error("Trip not found in other combined trips (false/true):", otherCombinedTrip.trip_id);
                        return;
                      }
                      const potentialTripIndex = trip.potential_trips.findIndex(pt => pt.trip_id === npt.trip_id);
                      if(potentialTripIndex > -1)
                      {
                        const updatedPotentialTrips = [...trip.potential_trips];
                        updatedPotentialTrips[potentialTripIndex] = {
                            ...updatedPotentialTrips[potentialTripIndex],
                            paid: true,
                            trip_group_id: newTripGroupId,
                            trip_obstruction: true,
                            group_largest_pickup_overlap_gap: calculatePickupOverlapGap(trip, npt),
                            group_largest_destination_overlap_gap: calculateDestinationOverlapGap(trip, npt),
                            total_seat_count: npt.seat_count
                        };
                        transaction.update(tripRef, { potential_trips: updatedPotentialTrips });

                      }
                    });

                    await Promise.all(otherTripPromises);


                    //Find trip to reserve for NPT

                    if (npt.matched_trips.length > 0) {

                      let tripToReserve: MatchedTrip | null = null;
                      let minDistance = Infinity;

                      for (const trip of npt.matched_trips) {
                        const combinedDistance = trip.pickup_distance + trip.destination_distance;
                        if (combinedDistance < minDistance) {
                          minDistance = combinedDistance;
                          tripToReserve = trip;
                        }
                      }

                      //Check for trips with same minimum distance
                      const tripsWithMinDistance = npt.matched_trips.filter(trip => {
                        const combinedDistance = trip.pickup_distance + trip.destination_distance;
                        return combinedDistance === minDistance;
                      });


                      if (tripsWithMinDistance.length > 1) {
                        //Multiple trips with same minimum distance, pick randomly
                        tripToReserve = tripsWithMinDistance[Math.floor(Math.random() * tripsWithMinDistance.length)];
                      }
                    
                    if(tripToReserve)
                    {
                       const tripToReserveRef = db.collection('trips').doc(tripToReserve.trip_id);
                      const tripToReserveDoc = await transaction.get(tripToReserveRef);
                      const tripData = tripToReserveDoc.data() as Trip;

                      // Update Newly Reserved Trip
                      transaction.update(tripToReserveRef, {
                        reserved: true,
                        reserving_trip_id: npt.trip_id
                      });

                    // Update NPT document

                    const nptMatchedTripIndex = npt.matched_trips.findIndex(mt => mt.trip_id === tripToReserve?.trip_id);
                    if(nptMatchedTripIndex > -1)
                    {
                       const updatedNPTMatchedTrips = [...npt.matched_trips];
                        updatedNPTMatchedTrips[nptMatchedTripIndex] = {
                         ...updatedNPTMatchedTrips[nptMatchedTripIndex],
                          reserving: true
                        };
                        transaction.update(nptRef, {
                        matched_trips: updatedNPTMatchedTrips
                        });
                    }
                  

                    //Get all the Newly Reserved Trip’s (matched trips with mutual as true and potential trips with mutual and false) that do not proper match the NPT

                      const combinedTripsForNotProperMatch: (MatchedTrip | PotentialTrip)[] = [];

                      for (const trip of tripData.matched_trips) {
                        if (trip.mutual) {
                          combinedTripsForNotProperMatch.push(trip);
                        }
                      }

                      for (const trip of tripData.potential_trips) {
                        if (!trip.mutual) {
                          combinedTripsForNotProperMatch.push(trip);
                        }
                      }

                      const notProperMatchTrips: (MatchedTrip | PotentialTrip)[] = [];

                      for (const trip of combinedTripsForNotProperMatch) {
                        const matchedIndex = npt.matched_trips.findIndex(mt => mt.trip_id === trip.trip_id && mt.mutual);
                        const potentialIndex = npt.potential_trips.findIndex(pt => pt.trip_id === trip.trip_id && !pt.mutual);

                        if (matchedIndex === -1 && potentialIndex === -1) {
                          notProperMatchTrips.push(trip);
                        }
                      }

                      // Update All the Newly Reserved Trip’s (matched trips with mutual as true and potential trips with mutual and false) that do not proper match the NPT documents

                      const notProperMatchPromises = notProperMatchTrips.map(async (trip) => {
                        const tripRef = db.collection('trips').doc(trip.trip_id);
                        const tripDoc = await transaction.get(tripRef);
                        const currentTrip = tripDoc.data() as Trip;
                        if (!currentTrip) {
                          console.error("Trip in notProperMatchTrips not found", trip.trip_id);
                          return;
                        }
                        
                        const deleteMatchedTripIndex = currentTrip.matched_trips.findIndex(mt => mt.trip_id === tripToReserve?.trip_id)

                         const updatedMatchedTrips = currentTrip.matched_trips.filter(mt => mt.trip_id !== tripToReserve?.trip_id);
                         const deletedMatchedTrip = currentTrip.matched_trips.find(mt => mt.trip_id === tripToReserve?.trip_id);

                        const potentialTripToBeAdded : PotentialTrip = {
                            trip_id: tripToReserve!.trip_id,
                            user_id: tripToReserve!.user_id,
                            paid: false,
                            trip_group_id: null,
                            pickup_radius: tripToReserve!.pickup_radius,
                            destination_radius: tripToReserve!.destination_radius,
                            pickup_distance: tripToReserve!.pickup_distance,
                            destination_distance: tripToReserve!.destination_distance,
                            proper_match: true,
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: true,
                            mutual: deletedMatchedTrip ? !deletedMatchedTrip.mutual : false,
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                            seat_count: tripToReserve!.seat_count,

                        };

                        const updatedPotentialTrips = [...currentTrip.potential_trips, potentialTripToBeAdded];

                        transaction.update(tripRef, {
                            matched_trips: updatedMatchedTrips,
                            potential_trips: updatedPotentialTrips
                        });
                       });

                      await Promise.all(notProperMatchPromises);


                        //Update Newly Reserved Trip’s matched and potential trips

                        const tripPromises4 = [...tripData.matched_trips, ...tripData.potential_trips].map(async (combinedTrip) => {
                            const match = notProperMatchTrips.find(notProper => notProper.trip_id === combinedTrip.trip_id);

                            if (match) {
                               const tripRef = db.collection('trips').doc(combinedTrip.trip_id);
                              const tripDoc = await transaction.get(tripRef);
                              const trip = tripDoc.data() as Trip;

                              if(trip)
                              {
                                  if (trip.matched_trips.length > 0) {
                                    const matchedTripIndex = trip.matched_trips.findIndex(mt => mt.trip_id === combinedTrip.trip_id);
                                     if(matchedTripIndex > -1)
                                    {
                                          const updatedMatchedTrips = [...trip.matched_trips];
                                          updatedMatchedTrips[matchedTripIndex] = {
                                            ...updatedMatchedTrips[matchedTripIndex],
                                            mutual: !updatedMatchedTrips[matchedTripIndex].mutual,
                                          };
                                          transaction.update(tripRef, {
                                            matched_trips: updatedMatchedTrips,
                                          });

                                    }
                                   
                                  }

                                    // For potential trips
                                  if (trip.potential_trips.length > 0) {
                                     const potentialTripIndex = trip.potential_trips.findIndex(pt => pt.trip_id === combinedTrip.trip_id);

                                      if(potentialTripIndex > -1)
                                    {
                                      const updatedPotentialTrips = [...trip.potential_trips];
                                      updatedPotentialTrips[potentialTripIndex] = {
                                        ...updatedPotentialTrips[potentialTripIndex],
                                        mutual: !updatedPotentialTrips[potentialTripIndex].mutual,
                                      };
                                      transaction.update(tripRef, {
                                        potential_trips: updatedPotentialTrips,
                                      });

                                    }
                                  }
                              }
                            }
                        });
                        await Promise.all(tripPromises4);




                      //Get the one’s that had only the newly reserved trip in their matched_trips array

                      const tripsWithOneMatchedTrip: Trip[] = [];

                      for (const trip of notProperMatchTrips) {
                         const tripRef = db.collection('trips').doc(trip.trip_id);
                          const tripDoc = await transaction.get(tripRef);
                          const currentTrip = tripDoc.data() as Trip;
                          if(currentTrip)
                          {
                             if (currentTrip.matched_trips.length === 1 && currentTrip.matched_trips[0].trip_id === tripToReserve?.trip_id) {
                              tripsWithOneMatchedTrip.push(currentTrip);
                             }

                          }
                      }

                      for (const trip of tripsWithOneMatchedTrip) {
                           const tripRef = db.collection('trips').doc(trip.trip_id);
                        transaction.update(tripRef, { status: "unmatched" });
                      }


                      // From the Newly Reserved Trip’s (matched trips with mutual as true and potential trips with mutual and false) that do not proper match the NPT,
                      //get the ones that are matched trips with mutual as “false” & potential trips with mutual as “true”

                        const otherTrips: (MatchedTrip | PotentialTrip)[] = [];

                        for (const trip of tripData.matched_trips) {
                            if (!trip.mutual) {
                            otherTrips.push(trip);
                            }
                        }

                        for (const trip of tripData.potential_trips) {
                            if (trip.mutual) {
                            otherTrips.push(trip);
                            }
                        }

                        //In each of their matched trips array, update the reserving_trip_obstruction field
                        for (const trip of otherTrips) {
                          const tripRef = db.collection('trips').doc(trip.trip_id);
                          const tripDoc = await transaction.get(tripRef);
                          const currentTrip = tripDoc.data() as Trip;
                          if(currentTrip)
                          {
                              if (currentTrip.matched_trips.length > 0) {
                                 const matchedTripIndex = currentTrip.matched_trips.findIndex(mt => mt.trip_id === tripToReserve?.// Continuation of the tripPaidFunction, inside the transaction

                                    trip_id);  //Find the index of the NPT
                                   if(matchedTripIndex > -1)
                                    {
                                      const updatedMatchedTrips = [...currentTrip.matched_trips];
                                      updatedMatchedTrips[matchedTripIndex] = {
                                          ...updatedMatchedTrips[matchedTripIndex],
                                          reserving_trip_obstruction: true //I think it should be this field and not the entire array ++
                                      }
                                      transaction.update(tripRef, {
                                          matched_trips: updatedMatchedTrips
                                      });
                                    }

                              }

                          }
                        }

                        // All choice TG members trip documents update:
                        const choiceTripGroupDoc = await transaction.get(choiceTripGroupRef);
                        const choiceTripGroupData = choiceTripGroupDoc.data() as TripGroup;

                        if(choiceTripGroupData)
                        {
                            for (const member of choiceTripGroupData.trip_group_members) {
                              const memberTripRef = db.collection('trips').doc(member.trip_id);
                              const memberTripDoc = await transaction.get(memberTripRef);
                              const memberTrip = memberTripDoc.data() as Trip;
                              if (memberTrip) {
                                //Update each of their total_seat_count field
                                transaction.update(memberTripRef, {
                                  total_seat_count: choiceTripGroupData.total_seat_count + npt.seat_count
                                });

                                // In each of their matched_trips array field, update the element containing NPT
                                  const memberMatchedTripIndex = memberTrip.matched_trips.findIndex(mt => mt.trip_id === npt.trip_id);
                                  if(memberMatchedTripIndex > -1)
                                  {
                                    const updatedMemberMatchedTrips = [...memberTrip.matched_trips]; // Copy
                                    updatedMemberMatchedTrips[memberMatchedTripIndex] = {
                                      ...updatedMemberMatchedTrips[memberMatchedTripIndex],
                                      paid: true,
                                      trip_group_id: choiceTripGroupData.trip_group_id
                                    };
                                     transaction.update(memberTripRef, { matched_trips: updatedMemberMatchedTrips });
                                  }

                              }
                            }

                            // Choice trip group document update
                            //Update total_seat_count field
                            transaction.update(choiceTripGroupRef, {
                              total_seat_count: choiceTripGroupData.total_seat_count + npt.seat_count
                            });

                            //In it’s potential_trip_members field delete the element containing NPT
                            const updatedPotentialTripMembers = choiceTripGroupData.potential_trip_members.filter(ptm => ptm.trip_id !== npt.trip_id);


                            //Add new trip_group_members element
                            const newTripGroupMember: TripGroupMember = {
                              trip_id: npt.trip_id,
                              user_id: npt.user_id,
                              first_name: user ? user.first_name : "",  // Use the user object
                              last_name: user ? user.last_name : "",
                              phone_number: user ? user.phone_number : "",
                              photo_url: user ? user.photo_url : "",
                              seat_count: npt.seat_count,
                              joined_timestamp: Timestamp.now(), // Use server timestamp
                              last_message_read_id: "",
                              earliest_date_time: npt.start_date_time,  // Use npt
                              latest_date_time: npt.end_date_time,     // Use npt
                            };



                            // In the choice TG’s potential trip members array, get all the trips that are not seat obstructed (seat_obstruction = false), but are now seat obstructed due to NPT’s entry
                            const newlySeatObstructedTrips: PotentialTripMember[] = [];
                            const totalSeatCountBeforeNpt = choiceTripGroupData.total_seat_count;  //Important

                            for (const trip of updatedPotentialTripMembers) {
                              if (trip.trip_id !== npt.trip_id && !trip.seat_obstruction) {
                                if (trip.seat_count > (4 - (totalSeatCountBeforeNpt + npt.seat_count))) {
                                  newlySeatObstructedTrips.push(trip);
                                }
                              }
                            }

                            //Choice trip group document update:
                            for (const trip of newlySeatObstructedTrips) {
                               const tripIndex = updatedPotentialTripMembers.findIndex(ptm => ptm.trip_id === trip.trip_id)
                               if(tripIndex > -1)
                               {
                                  updatedPotentialTripMembers[tripIndex] = {
                                    ...updatedPotentialTripMembers[tripIndex],
                                    seat_obstruction: true
                                  }
                               }
                            }
                            transaction.update(choiceTripGroupRef, {
                                  potential_trip_members: updatedPotentialTripMembers,
                                  trip_group_members: [...choiceTripGroupData.trip_group_members, newTripGroupMember]
                            });

                        }

                    }

                    } else {
                      //No matched trips
                    }

                }
            }
        });

    } catch (error) {
        console.error("Transaction failed: ", error);
        //  Consider throwing the error to let Firebase know the function failed.
        //  This will also enable retries, which can be helpful for transient errors.
         throw error;
    }
});