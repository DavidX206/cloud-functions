/* eslint-disable linebreak-style */
/* eslint-disable no-empty */
/* eslint-disable indent */
/* eslint-disable max-len */
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const axios = require("axios");

const db = require("./firebaseAdmin");

exports.tripCanceledFunction = onDocumentUpdated("users/{userId}/trips/{tripId}",
    async (event) => {
      try {
        const arrayRemove = db.FieldValue.arrayRemove;
        const arrayUnion = db.FieldValue.arrayUnion;
        const userId = event.params.userId;
        const tripId = event.params.tripId;
        const snapshot = event.data;

        if (!snapshot) {
          console.log("No data associated with the event");
          return;
        }

        const newTripData = snapshot.after.data();
        // const previousData = snapshot.before.data();

        const getOldTripData = async (tripId) => {
            try {
                const querySnapshot = await db
                    .collectionGroup("trips")
                    .where("trip_id", "==", tripId)
                    .get();

                if (!querySnapshot.empty) {
                    const doc = querySnapshot.docs[0]; // Get the first matching document
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;

                    // Get the specific trip document reference under the user's collection
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trips`)
                        .doc(tripId);

                    const oldTripDoc = await oldTripDocRef.get();

                    if (oldTripDoc.exists) {
                        const oldTripData = oldTripDoc.data();
                        return [oldTripData, oldTripDocRef];
                    } else {
                        console.log("Old trip document does not exist");
                        return null;
                    }
                } else {
                    console.log("No matching trip found in collectionGroup");
                    return null;
                }
            } catch (error) {
                console.error("Error in getOldTripData:", error);
                return null;
            }
        };

        const getTripGroupData = async (tripGroupId) => {
            const oldTripGroupDocRef = db
                .collection(`users/${userId}/trips`)
                .doc(tripId);
            const oldTripGroupDoc = await oldTripGroupDocRef.get();
            // Fetch trip group data by ID
            return oldTripGroupDoc.data();
          };

        const deleteTripGroup = async (tripGroupId) => {
          // Delete the trip group document
          await db.collection("trip_groups").doc(tripGroupId).delete();
        };

        const calculateCentroid = (locations) => {
          const total = locations.reduce(
              (acc, loc) => {
                  acc.lat += loc.lat;
                  acc.lng += loc.lng;
                  return acc;
              },
              {lat: 0, lng: 0},
          );

          return {
              lat: total.lat / locations.length,
              lng: total.lng / locations.length,
          };
        };

        const calculateDistance = (loc1, loc2) => {
            const toRadians = (degrees) => degrees * (Math.PI / 180);
            const R = 6371; // Radius of the Earth in kilometers

            const dLat = toRadians(loc2.lat - loc1.lat);
            const dLng = toRadians(loc2.lng - loc1.lng);

            const a =
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRadians(loc1.lat)) *
                    Math.cos(toRadians(loc2.lat)) *
                    Math.sin(dLng / 2) *
                    Math.sin(dLng / 2);

            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

            return R * c; // Distance in kilometers
          };

        const getDistanceMatrix = async (origins, destinations) => {
          const apiKey = process.env.RADAR_API_KEY;
          const url = `https://api.radar.io/v1/route/matrix?origins=${origins}&destinations=${destinations}`;

          try {
              const response = await axios.get(url, {
                  headers: {
                      Authorization: `Bearer ${apiKey}`,
                  },
              });
              return response.data;
          } catch (error) {
              console.error("Error calling Radar Route Matrix API:", error);
              throw new Error("Failed to retrieve route matrix");
          }
        };

        // Change status changed to canceled
        await snapshot.after.ref.update({
          status: "canceled",
        });

        // Process matched trips if they exist
        if (newTripData.matched_trips && newTripData.matched_trips.length > 0) {
          if (newTripData.matched_trips.some((trip) => trip.reserving)) {
            // Update the trip that was reserving the canceled trip
            for (const matchedTrip in newTripData.matched_trips) {
              if (matchedTrip.reserving) {
                const reservedTrip = await getOldTripData(matchedTrip.trip_id);
                await reservedTrip[1].update({
                  reserved: false,
                  reserving_trip_id: db.FieldValue.delete(),
                });
                const reservingTripMatchedTrips = reservedTrip[0].matched_trips.filter((trip) => trip.mutual === false);
                const reservingTripPotentialTrips = reservedTrip[0].potential_trips.filter((trip) => trip.mutual === true);
                const combinedTrips = [...reservingTripMatchedTrips, ...reservingTripPotentialTrips];
                const combinedTripsData = combinedTrips.map(async (combinedTrip) => {
                  const combinedTripData = await getOldTripData(combinedTrip.trip_id);
                  return combinedTripData;
                });

                for (const combinedTripData of combinedTripsData) {
                  await combinedTripData[1].update({
                    potential_trips: combinedTripData[0].potential_trips.map((trip) => {
                      if (combinedTripData[0].potential_trips.some(
                        (potentialTrip) => potentialTrip.reserving_trip_obstruction === true && potentialTrip.proper_match === false,
                        )) {
                        return {
                          ...trip,
                          reserving_trip_obstruction: false,
                        };
                      }
                      return trip;
                    }),
                  });
                  const updatedPotentialTrips = combinedTripData[0].potential_trips.filter(
                  (trip) => !trip[0].potential_trips.some(
                    (potentialTrip) => potentialTrip.reserving_trip_obstruction === true && potentialTrip.proper_match === true,
                    ),
                );

                // Add each of the remaining trip_group_members to matched_trips array
                const updatedMatchedTrips = [
                  ...combinedTripData[0].matched_trips,
                  ...combinedTripData[0].potential_trips.filter(
                    (trip) => trip[0].potential_trips.some(
                      (potentialTrip) => potentialTrip.reserving_trip_obstruction === true && potentialTrip.proper_match === true,
                      ),
                  ).map((reservedTrip) => ({
                    trip_id: reservedTrip.trip_id,
                    paid: false,
                    trip_group_id: null,
                    pickup_radius: reservedTrip.pickup_radius,
                    destination_radius: reservedTrip.destination_radius,
                    pickup_distance: reservedTrip.pickup_distance,
                    destination_distance: reservedTrip.destination_distance,
                    mutual: !reservedTrip.mutual,
                    reserving: false,
                  })),
                ];

                // Update the potential_trip document
                await combinedTripData[1].update({
                  potential_trips: updatedPotentialTrips,
                  matched_trips: updatedMatchedTrips,
                });
              }
              const updatedMatchedTrips = reservedTrip[0].matched_trips.map((trip) => {
                if (!trip.mutual && trip.proper_match) {
                  return {
                    ...trip,
                    mutual: true,
                  };
                }
                return trip;
              });

              const updatedPotentialTrips = reservedTrip[0].potential_trips.map((trip) => {
                if (trip.mutual && trip.proper_match) {
                  return {
                    ...trip,
                    mutual: false,
                  };
                }
                return trip;
              });

              await reservedTrip[1].update({
                matched_trips: updatedMatchedTrips,
                potential_trips: updatedPotentialTrips,
              });
              }
            }
          }

          // Iterate through each matched trip
          for (const matchedTrip of newTripData.matched_trips) {
            const matchedTripRef = await db
                .collection(`users`)
                .doc(matchedTrip.user_id)
                .collection("trips")
                .doc(matchedTrip.trip_id)
                .get();

            if (!matchedTripRef.exists) {
              console.log(`Matched trip ${matchedTrip.trip_id} not found`);
              continue;
            }

            // const matchedTripData = matchedTripRef.data();

            // Check if the match is mutual
            if (matchedTrip.mutual) {
              // Remove canceled trip from matched_trips array
              await matchedTripRef.ref.update({
                matched_trips: arrayRemove({
                  trip_id: tripId,
                  user_id: userId,
                  // Include all other fields that were in the matched_trips array
                  // These should match exactly what was stored
                }),
              });

              // If this was the only matched trip, set status to unmatched
              const updatedMatchedTripData = await matchedTripRef.get();
              if (!updatedMatchedTripData.data().matched_trips.length) {
                await matchedTripRef.ref.update({
                  status: "unmatched",
                });
              }
            } else {
              // If not mutual, remove from potential_trips instead
              await matchedTripRef.ref.update({
                potential_trips: arrayRemove({
                  trip_id: tripId,
                  user_id: userId,
                  // Include all other fields that were in the potential_trips array
                }),
              });
            }
          }
        }

        // Process potential trips if they exist
        if (newTripData.potential_trips && newTripData.potential_trips.length > 0) {
            // Iterate through each potential trip
            for (const potentialTrip of newTripData.potential_trips) {
              const potentialTripRef = await db
                  .collection(`users`)
                  .doc(potentialTrip.user_id)
                  .collection("trips")
                  .doc(potentialTrip.trip_id)
                  .get();

              if (!potentialTripRef.exists) {
                console.log(`Potential trip ${potentialTrip.trip_id} not found`);
                continue;
              }

              // const potentialTripData = potentialTripRef.data();

              // Check if the potential match is mutual
              if (potentialTrip.mutual) {
                // Remove canceled trip from potential_trips array
                await potentialTripRef.ref.update({
                  potential_trips: arrayRemove({
                    trip_id: tripId,
                    // Include all other fields that were in the potential_trips array
                  }),
                });
              } else {
                // Remove from matched_trips array
                await potentialTripRef.ref.update({
                  matched_trips: arrayRemove({
                    trip_id: tripId,
                    // Include all other fields that were in the matched_trips array
                  }),
                });

                // Check if it was the only matched trip
                const updatedPotentialTripData = await potentialTripRef.get();
                if (!updatedPotentialTripData.data().matched_trips.length) {
                  await potentialTripRef.ref.update({
                    status: "unmatched",
                  });
                }
              }
            }
          }

           // Check if the canceled trip was reserved
        if (newTripData.reserved) {
            // Get the reserving trip's data
            const reservingTripRef = await db
                .collectionGroup("trips")
                .where("trip_id", "==", newTripData.reserving_trip_id)
                .get();

            if (!reservingTripRef.empty) {
              const reservingTripDoc = reservingTripRef.docs[0];
              const reservingTripData = reservingTripDoc.data();

              // Check if the reserving trip has other matched trips besides the canceled one
              const otherMatchedTrips = reservingTripData.matched_trips.filter(
                  (mt) => mt.trip_id !== tripId,
              );

              if (otherMatchedTrips && otherMatchedTrips.length > 0) {
                // Find the trip with the nearest combined pickup and destination distance
                let shortestCombinedDistance = Infinity;

                for (const matchedTrip of otherMatchedTrips) {
                  const combinedDistance =
                      matchedTrip.pickup_distance + matchedTrip.destination_distance;

                  if (combinedDistance < shortestCombinedDistance) {
                    shortestCombinedDistance = combinedDistance;
                  }
                }
                const nearestTrips = otherMatchedTrips.filter(
                (trip) => trip.pickup_distance + trip.destination_distance === shortestCombinedDistance,
                );

                let selectedNearestTrip = null;

                // If multiple nearest trips, randomly pick one
                if (nearestTrips.length > 1) {
                selectedNearestTrip = nearestTrips[Math.floor(Math.random() * nearestTrips.length)];
                } else {
                // Otherwise, take the only nearest trip
                selectedNearestTrip = nearestTrips[0];
                }

                const [newlyReservedTripData, newlyReservedTripRef] = await getOldTripData(selectedNearestTrip.trip_id);

                if (newlyReservedTripData) {
                    // Update the newly reserved trip to be reserved by the former reserving trip
                    await newlyReservedTripRef.update({
                        reserved: true,
                        reserving_trip_id: reservingTripData.trip_id,
                    });

                    const newlyReservedTripId = selectedNearestTrip.trip_id;

                    // Update the former reserving trip's matched_trips array to reflect the new reservation
                    const updatedReservingTripMatchedTrips = reservingTripData.matched_trips.map((trip) =>
                        trip.trip_id === newlyReservedTripId ? {...trip, reserving: true} : trip,
                    );

                    await reservingTripDoc.ref.update({
                        matched_trips: updatedReservingTripMatchedTrips,
                    });

                    // Process newly reserved trip's matches and potentials to get trips that don't proper match with reserving trip
                    const unmatchedTrips = [...(newlyReservedTripData.matched_trips.filter((trip) => trip.mutual === true) || []), ...(newlyReservedTripData.potential_trips.filter((trip) => trip.mutual === false) || [])]
                        .filter((trip) =>
                        !reservingTripData.matched_trips.some((matchedTrip) => matchedTrip.trip_id === trip.trip_id && matchedTrip.mutual) &&
                        !reservingTripData.potential_trips.some((potentialTrip) => potentialTrip.trip_id === trip.trip_id && !potentialTrip.mutual),
                        );

                    // Filter trips from unmatchedTrips that only have the newly reserved trip in their matched_trips array
                    const tripsToUnmatch = unmatchedTrips.filter(async (trip) => {
                        const tripData = await getOldTripData(trip.trip_id);
                        const matchedTrips = tripData[0].matched_trips || [];

                        // Check if the matched_trips array contains only the newly reserved trip
                        return matchedTrips.length === 1 && matchedTrips[0].trip_id === newlyReservedTripId;
                    });

                    // Update the status of these trips to "unmatched"
                    await Promise.all(
                        tripsToUnmatch.map(async (trip) => {
                        const tripRef = await getOldTripData(trip.trip_id)[1]; // Get reference to the trip document
                        await tripRef.update({
                            status: "unmatched",
                        });
                        }),
                    );

                    // Update trips that dont proper match with reserving trip
                    for (const unmatchedTrip of unmatchedTrips) {
                        const unmatchedTripRef = db
                        .collection("users")
                        .doc(unmatchedTrip.user_id)
                        .collection("trips")
                        .doc(unmatchedTrip.trip_id);

                        const unmatchedTripDoc = await unmatchedTripRef.get();
                        if (unmatchedTripDoc.exists) {
                        const unmatchedTripData = unmatchedTripDoc.data();

                        const matchedTripToDelete = unmatchedTripData.matched_trips.find(
                            (matchedTrip) => matchedTrip.trip_id === newlyReservedTripId,
                        );

                        await unmatchedTripRef.update({
                        matched_trips: arrayRemove({
                            trip_id: newlyReservedTripId,
                        }),
                        });

                        await unmatchedTripRef.update({
                        potential_trips: arrayUnion({
                            trip_id: newlyReservedTripId,
                            paid: false,
                            trip_group_id: null,
                            pickup_radius: matchedTripToDelete.pickup_radius,
                            destination_radius: matchedTripToDelete.destination_radius,
                            pickup_distance: matchedTripToDelete.pickup_distance,
                            destination_distance: matchedTripToDelete.destination_distance,
                            proper_match: true,
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: true,
                            mutual: !matchedTripToDelete.mutual,
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                        }),
                        });
                        }
                    }

                    // Reverse the mututal status of trips (the ones that don't proper match with reserving trip) that are in the newly reserved trip's potential_trips and matched_trips
                    const updatedNewlyReservedTripPotentialTrips = (newlyReservedTripData.potential_trips || []).map((trip) => {
                        const unmatched = unmatchedTrips.find((unmatchedTrip) => unmatchedTrip.trip_id === trip.trip_id);
                        return unmatched ? {...trip, mutual: !trip.mutual} : trip;
                      });

                    const updatedNewlyReservedTripMatchedTrips = (newlyReservedTripData.matched_trips || []).map((trip) => {
                    const unmatched = unmatchedTrips.find((unmatchedTrip) => unmatchedTrip.trip_id === trip.trip_id);
                    return unmatched ? {...trip, mutual: !trip.mutual} : trip;
                    });

                    // Apply the updates to the newly reserved trip document
                    await newlyReservedTripRef.update({
                    potential_trips: updatedNewlyReservedTripPotentialTrips,
                    matched_trips: updatedNewlyReservedTripMatchedTrips,
                    });
                }
                } else {
                    const tripGroupId = reservingTripData.trip_group_id;
                    if (tripGroupId) {
                        await db.collection("trip_groups").doc(tripGroupId).delete();
                    }

                    // Update the former reserving trip's document
                    await reservingTripDoc.ref.update({
                        status: "unmatched",
                        trip_group_id: db.FieldValue.delete(),
                        time_of_payment: db.FieldValue.delete(),
                        total_seat_count: db.FieldValue.delete(),
                    });

                    // Update the former reserving trip user’s document
                    const userRef = db.collection( "users").doc(reservingTripData.user_id);
                    const userDoc = await userRef.get();

                    if (userDoc.exists) {
                        const currentTicketCount = userDoc.data().ticket_count || 0;
                        await userRef.update({
                            ticket_count: currentTicketCount + 1,
                        });
                    }

                    // Update all potential trips of the former reserving trip
                    if (reservingTripData.potential_trips && reservingTripData.potential_trips.length > 0) {
                        for (const potentialTrip of reservingTripData.potential_trips) {
                            const potentialTripRef = db
                                .collection("users")
                                .doc(potentialTrip.user_id)
                                .collection("trips")
                                .doc(potentialTrip.trip_id);

                            const potentialTripDoc = await potentialTripRef.get();

                            if (potentialTripDoc.exists) {
                                const potentialTripsArray = potentialTripDoc.data().potential_trips;

                                // Find and update the specific element within the potential_trips array
                                const updatedPotentialTrips = potentialTripsArray.map((pt) => {
                                    if (pt.trip_id === reservingTripData.trip_id) {
                                        return {
                                            ...pt,
                                            paid: false,
                                            trip_group_id: db.FieldValue.delete(),
                                            trip_obstruction: false,
                                            group_largest_pickup_overlap_gap: db.FieldValue.delete(),
                                            group_largest_destination_overlap_gap: db.FieldValue.delete(),
                                            total_seat_count: db.FieldValue.delete(),
                                        };
                                    }
                                    return pt;
                                });

                                // Update the potential_trip document
                                await potentialTripRef.update({
                                    potential_trips: updatedPotentialTrips,
                                });
                            }
                        }
                    }
              }
            }
          }

          if (newTripData.paid) {
            // add logic to delete cancelled trip from trip_group_members array

            // Query to check if this trip is the only member in the trip group
            const tripGroupData = await getTripGroupData(newTripData.trip_group_id);

            if (tripGroupData.trip_group_members.length === 0) {
                // Only member in the trip group => delete the trip group
                await deleteTripGroup(newTripData.trip_group_id);
            } else { // Not the only member in the trip group => Check if there is more than one trip left in the group
                if (tripGroupData.trip_group_members.length > 1) {
                    // There are other trips in the group, so update accordingly

                    const tripGroupMembersData = tripGroupData.trip_group_members.map((member) => {
                        return getOldTripData(member.trip_id)[0];
                    });

                    const pickupLocations = tripGroupMembersData.map((member) => member.pickup_latlng);
                    const destinationLocations = tripGroupMembersData.map((member) => member.destination_latlng);

                    const pickupCentroid = calculateCentroid(pickupLocations);
                    const destinationCentroid = calculateCentroid(destinationLocations);

                    const pickupDistances = pickupLocations.map((loc) => calculateDistance(loc, pickupCentroid));
                    const destinationDistances = destinationLocations.map((loc) => calculateDistance(loc, destinationCentroid));

                    // const farthestPickup = pickupLocations[pickupDistances.indexOf(Math.max(...pickupDistances))];
                    // const farthestDestination = destinationLocations[destinationDistances.indexOf(Math.max(...destinationDistances))];

                    const origins = `${pickupLocations.map((loc) => `${loc.lat},${loc.lng}`).join("|")}|${destinationLocations.map((loc) => `${loc.lat},${loc.lng}`).join("|")}`;

                    const destinations = `${pickupCentroid.lat},${pickupCentroid.lng}|${destinationCentroid.lat},${destinationCentroid.lng}`;

                    const distanceMatrix = await getDistanceMatrix(origins, destinations);

                    const pickupToDestinationCentroidDistances = distanceMatrix.matrix.slice(0, pickupLocations.length).map((origin) => origin[1].distance.value);
                    const destinationToPickupCentroidDistances = distanceMatrix.matrix.slice(pickupLocations.length).map((destination) => destination[0].distance.value);

                    const closestPickupToDestinationCentroid = pickupLocations[pickupToDestinationCentroidDistances.indexOf(Math.min(...pickupToDestinationCentroidDistances))];
                    const closestDestinationToPickupCentroid = destinationLocations[destinationToPickupCentroidDistances.indexOf(Math.min(...destinationToPickupCentroidDistances))];

                    const closestPickupToDestinationCentroidIndex = pickupLocations.findIndex((loc) => loc.lat === closestPickupToDestinationCentroid.lat && loc.lng === closestPickupToDestinationCentroid.lng);

                    const closestDestinationToPickupCentroidIndex = destinationLocations.findIndex((loc) => loc.lat === closestDestinationToPickupCentroid.lat && loc.lng === closestDestinationToPickupCentroid.lng);

                    const apiKey = process.env.GOOGLE_API_KEY;
                    const headers = {
                      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
                      "X-Goog-Api-Key": apiKey,
                    };

                    const pickupRequestBody = {
                      excludedPrimaryTypes: ["administrative_area_level_1"],
                      locationRestriction: {
                        circle: {
                          center: {
                            latitude: pickupCentroid.lat,
                            longitude: pickupCentroid.lng,
                          },
                          radius: Math.max(...pickupDistances),
                        },
                      },
                    };

                    const destinationRequestBody = {
                      excludedPrimaryTypes: ["administrative_area_level_1"],
                      locationRestriction: {
                        circle: {
                          center: {
                            latitude: destinationCentroid.lat,
                            longitude: destinationCentroid.lng,
                          },
                          radius: Math.max(...destinationDistances),
                        },
                      },
                    };

                    const pickupSuggestionsData = await axios.post(
                      "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                      pickupRequestBody,
                      {headers},
                    );

                    const destinationSuggestionsData = await axios.post(
                      "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
                      destinationRequestBody,
                      {headers},
                    );

                    const pickupSuggestions = pickupSuggestionsData.data.results.slice(0, 20);
                    const destinationSuggestions = destinationSuggestionsData.data.results.slice(0, 20);

                    const pickupOrigins = pickupLocations.map((loc) => `${loc.lat},${loc.lng}`).join("|");
                    const destinationOrigins = destinationLocations.map((loc) => `${loc.lat},${loc.lng}`).join("|");

                    const pickupSuggestionsDestinations = pickupSuggestions.map((suggestion) => `${suggestion.geometry.location.lat},${suggestion.geometry.location.lng}`).join("|");
                    const destinationSuggestionsDestinations = destinationSuggestions.map((suggestion) => `${suggestion.geometry.location.lat},${suggestion.geometry.location.lng}`).join("|");

                    const pickupDistanceMatrix = await getDistanceMatrix(pickupOrigins, pickupSuggestionsDestinations);

                    const destinationDistanceMatrix = await getDistanceMatrix(destinationOrigins, destinationSuggestionsDestinations);

                    const pickupSuggestionsWithinRadius = tripGroupMembersData.map((member, index) => {
                      const distances = pickupDistanceMatrix.matrix[index].map((element) => element.distance.value);
                      return pickupSuggestions.filter((_, suggestionIndex) => distances[suggestionIndex] <= member.pickup_radius);
                    });

                    const destinationSuggestionsWithinRadius = tripGroupMembersData.map((member, index) => {
                      const distances = destinationDistanceMatrix.matrix[index].map((element) => element.distance.value);
                      return destinationSuggestions.filter((_, suggestionIndex) => distances[suggestionIndex] <= member.destination_radius);
                    });

                    const pickupSuggestionsWithinEachRadius = pickupSuggestionsWithinRadius.reduce((acc, suggestions) => {
                      if (acc === null) return suggestions;
                      return acc.filter((suggestion) =>
                        suggestions.some((s) => s.place_id === suggestion.place_id),
                      );
                    }, null);

                    const destinationSuggestionsWithinEachRadius = destinationSuggestionsWithinRadius.reduce((acc, suggestions) => {
                      if (acc === null) return suggestions;
                      return acc.filter((suggestion) =>
                        suggestions.some((s) => s.place_id === suggestion.place_id),
                      );
                    }, null);

                    // Order pickup suggestions
                    const orderedPickupSuggestionsWithinEachRadius = pickupSuggestionsWithinEachRadius.sort((a, b) => {
                      const distances = pickupDistanceMatrix.matrix[closestPickupToDestinationCentroidIndex].map((element) => element.distance.value);
                      const distanceA = distances[pickupSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === a.place_id)];

                      const distanceB = distances[pickupSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === b.place_id)];
                      return distanceA - distanceB;
                    });

                    const orderedPickupSuggestionsIndices = orderedPickupSuggestionsWithinEachRadius.map((suggestion) =>
                      pickupSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === suggestion.place_id),
                    );

                    // Order destination suggestions
                    const orderedDestinationSuggestionsWithinEachRadius = destinationSuggestionsWithinEachRadius.sort((a, b) => {
                      const distances = destinationDistanceMatrix.matrix[closestDestinationToPickupCentroidIndex].map((element) => element.distance.value);
                      const distanceA = distances[destinationSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === a.place_id)];
                      const distanceB = distances[destinationSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === b.place_id)];
                      return distanceA - distanceB;
                    });

                    const orderedDestinationSuggestionsIndices = orderedDestinationSuggestionsWithinEachRadius.map((suggestion) =>
                      destinationSuggestions.findIndex((originalSuggestion) => originalSuggestion.place_id === suggestion.place_id),
                    );

                    // Update the trip group document with new pickup and destination suggestions
                    await db.collection("trip_groups").doc(newTripData.trip_group_id).update({
                      pickup_location_suggestions: arrayUnion(
                      ...orderedPickupSuggestionsWithinEachRadius.map((suggestion, index) => ({
                        pickup_suggestion_name: suggestion.name,
                        pickup_suggestion_address: suggestion.vicinity,
                        pickup_suggestion_location: suggestion.geometry.location,
                        distances_from_trip_pickup_locations: tripGroupMembersData.map((member, memberIndex) => ({
                          trip_id: member.trip_id,
                          walking_distance: pickupDistanceMatrix.matrix[memberIndex][orderedPickupSuggestionsIndices[index]].distance.value,
                        })),
                      })),
                      ),
                      destination_suggestions: arrayUnion(
                      ...orderedDestinationSuggestionsWithinEachRadius.map((suggestion, index) => ({
                        destination_suggestion_name: suggestion.name,
                        destination_suggestion_address: suggestion.vicinity,
                        destination_suggestion_location: suggestion.geometry.location,
                        distances_from_trip_destination_locations: tripGroupMembersData.map((member, memberIndex) => ({
                          trip_id: member.trip_id,
                          walking_distance: destinationDistanceMatrix.matrix[memberIndex][orderedDestinationSuggestionsIndices[index]].distance.value,
                        })),
                      })),
                      ),
                    });
                } else {
                    // Only one trip left, execute additional logic here
                    const remainingTrip = tripGroupData.trip_group_members[0];
                    const remainingTripData = await getOldTripData(remainingTrip.trip_id);

                    // Check if the remaining trip has any other matched trips besides the canceled one
                    const otherMatchedTrips = remainingTripData[0].matched_trips.filter(
                        (mt) => mt.trip_id !== tripId,
                    );

                    if (otherMatchedTrips.length === 0) {
                        // No other matched trips, update status to unmatched
                        await remainingTripData[1].update({
                            status: "unmatched",
                            trip_group_id: db.FieldValue.delete(),
                            payment_time: db.FieldValue.delete(),
                            total_seat_count: db.FieldValue.delete(),
                        });

                        // Update user document's ticket_count
                        const userRef = db.collection("users").doc(remainingTripData[0].user_id);
                        const userDoc = await userRef.get();

                        if (userDoc.exists) {
                            const currentTicketCount = userDoc.data().ticket_count || 0;
                            await userRef.update({
                                ticket_count: currentTicketCount + 1,
                            });
                        }
                        await deleteTripGroup(newTripData.trip_group_id);
                    }
                }

                // Update the trip group's total_seat_count
                await db.collection("trip_groups").doc(newTripData.trip_group_id).update({
                  total_seat_count: tripGroupData.total_seat_count - newTripData.seat_count,
                });

                // Update each remaining trip group member's total_seat_count field
                for (const member of tripGroupData.trip_group_members) {
                  const remainingTripData = await getOldTripData(member.trip_id);

                  const currentSeatCount = remainingTripData[0].total_seat_count || 0;
                  await remainingTripData[1].update({
                    total_seat_count: currentSeatCount - newTripData.seat_count,
                  });
                }

                // Get all potential_trip_members with trip_obstruction as true or seat_obstruction as true
                const potentialTripMembers = tripGroupData.potential_trip_members.filter(
                  (member) => member.trip_obstruction || member.seat_obstruction,
                );

                // For each of potential_trip_members above
                for (const member of potentialTripMembers) {
                  // Declare variables
                  let tripObstruction = member.trip_obstruction;
                  let unknownTripObstruction = member.unknown_trip_obstruction;
                  let seatObstruction = member.seat_obstruction;

                  // Add your logic here to handle these variables
                  if (tripObstruction) {
                    const potentialTripData = await getOldTripData(member.trip_id);

                    // Check if the canceled trip is one of the obstructing_trip_members
                    const obstructingTripIndex = member.obstructing_trip_members.findIndex(
                    (obstructingTrip) => obstructingTrip.trip_id === tripId,
                    );

                    if (obstructingTripIndex !== -1) {
                      // Remove the canceled trip from obstructing_trip_members
                      member.obstructing_trip_members.splice(obstructingTripIndex, 1);

                      // Check if the canceled trip was the only obstructing_trip_member
                      if (member.obstructing_trip_members.length === 0) {
                        // Check if the potential trip member's seat_count is greater than or equal to the trip group's total_seat_count minus the canceled trip's seat_count
                        const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                        if (member.seat_count <= tripGroupData.total_seat_count) {
                          await potentialTripData[1].update({
                            potential_trips: potentialTripData[0].potential_trips.map((trip) => {
                                if (tripGroupData.trip_group_members.some((groupMember) => groupMember.trip_id === trip.trip_id)) {
                                  return {
                                    ...trip,
                                    group_largest_pickup_overlap_gap: db.FieldValue.delete(),
                                    group_largest_destination_overlap_gap: db.FieldValue.delete(),
                                  };
                              }
                              return trip;
                            }),
                          });
                        }
                        tripObstruction = false;
                        unknownTripObstruction = false;
                        if (member.seat_count <= tripGroupData.total_seat_count) {
                          seatObstruction = false;
                        } else seatObstruction = true;
                      } else {
                        tripObstruction = true;
                        // Check if the canceled trip was an unknown trip obstruction
                        if (unknownTripObstruction) {
                          const unknownObstructingTripIndex = member.obstructing_trip_members.findIndex(
                            (obstructingTrip) => obstructingTrip.unknown === true,
                          );

                          if (unknownObstructingTripIndex !== -1) {
                            // Remove the canceled trip from unknown_obstructing_trip_members
                            member.obstructing_trip_members.splice(unknownObstructingTripIndex, 1);

                            // Check if the canceled trip was the only unknown trip obstruction
                            if (!member.obstructing_trip_members.some((obstructingTrip) => obstructingTrip.unknown === true)) {
                              unknownTripObstruction = false;

                              // Update the potential_trip_members field in the trip group document
                              const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                              await db.collection("trip_groups").doc(newTripData.trip_group_id).update({
                                potential_trip_members: tripGroupData.potential_trip_members.map((trip) => {
                                  if (member.trip_id === trip.trip_id) {
                                    return {
                                      ...trip,
                                      unknown_trip_obstruction: false,
                                    };
                                  }
                                    return trip;
                                  }),
                              });
                            } else {
                              unknownTripObstruction = true;
                            }
                            const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                            if (member.seat_count <= tripGroupData.total_seat_count) {
                              seatObstruction = false;
                            } else seatObstruction = true;
                          }
                        } else {
                            const remainingObstructingTrips = member.obstructing_trip_members.filter(
                              (obstructingTrip) => obstructingTrip.trip_id !== tripId && obstructingTrip.unknown === false,
                            );

                            if (remainingObstructingTrips.length > 0) {
                              const pickupOverlapGaps = [];
                              const destinationOverlapGaps = [];

                              const potentialTripData = await getOldTripData(member.trip_id);
                              for (const obstructingTrip of remainingObstructingTrips) {
                                const obstructingTripData = await getOldTripData(obstructingTrip.trip_id);


                                const pickupDistance = potentialTripData[0].potential_trips.find(
                                  (trip) => trip.trip_id === obstructingTripData[0].trip_id,
                                ).pickup_distance;

                                const destinationDistance = potentialTripData[0].potential_trips.find(
                                  (trip) => trip.trip_id === obstructingTripData[0].trip_id,
                                ).destination_distance;

                                const pickupOverlapGap = 150 - (member.pickup_radius + obstructingTripData[0].pickup_radius - pickupDistance);
                                const destinationOverlapGap = 150 - (member.destination_radius + obstructingTripData[0].destination_radius - destinationDistance);

                                pickupOverlapGaps.push(pickupOverlapGap > 0 ? pickupOverlapGap : "N/A");
                                destinationOverlapGaps.push(destinationOverlapGap > 0 ? destinationOverlapGap : "N/A");
                              }

                              const largestPickupOverlapGap = Math.max(...pickupOverlapGaps.filter((gap) => gap !== "N/A"));
                              const largestDestinationOverlapGap = Math.max(...destinationOverlapGaps.filter((gap) => gap !== "N/A"));

                              await potentialTripData[1].update({
                                potential_trips: potentialTripData[0].potential_trips.map((trip) => {
                                  if (tripGroupData.trip_group_members.some((groupMember) => groupMember.trip_id === trip.trip_id)) {
                                    return {
                                      ...trip,
                                      group_largest_pickup_overlap_gap: largestPickupOverlapGap !== -Infinity ? largestPickupOverlapGap : "N/A",
                                      group_largest_destination_overlap_gap: largestDestinationOverlapGap !== -Infinity ? largestDestinationOverlapGap : "N/A",
                                    };
                                  }
                                  return trip;
                                }),
                              });
                            }
                            const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                            if (member.seat_count <= tripGroupData.total_seat_count) {
                              seatObstruction = false;
                            } else seatObstruction = true;
                        }
                      }
                    } else {
                      tripObstruction = true;
                      // Check if the canceled trip was an unknown trip obstruction
                      if (unknownTripObstruction) {
                        const unknownObstructingTripIndex = member.obstructing_trip_members.findIndex(
                          (obstructingTrip) => obstructingTrip.unknown === true,
                        );

                        if (unknownObstructingTripIndex !== -1) {
                          // Remove the canceled trip from unknown_obstructing_trip_members
                          member.obstructing_trip_members.splice(unknownObstructingTripIndex, 1);

                          // Check if the canceled trip was the only unknown trip obstruction
                          if (!member.obstructing_trip_members.some((obstructingTrip) => obstructingTrip.unknown === true)) {
                            unknownTripObstruction = false;

                            // Update the potential_trip_members field in the trip group document
                            const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                            await db.collection("trip_groups").doc(newTripData.trip_group_id).update({
                              potential_trip_members: tripGroupData.potential_trip_members.map((trip) => {
                                if (member.trip_id === trip.trip_id) {
                                  return {
                                    ...trip,
                                    unknown_trip_obstruction: false,
                                  };
                                }
                                  return trip;
                                }),
                            });
                          } else {
                            unknownTripObstruction = true;
                          }
                          const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                          if (member.seat_count <= tripGroupData.total_seat_count) {
                            seatObstruction = false;
                          } else seatObstruction = true;
                        }
                      } else {
                          const remainingObstructingTrips = member.obstructing_trip_members.filter(
                            (obstructingTrip) => obstructingTrip.trip_id !== tripId && obstructingTrip.unknown === false,
                          );

                          if (remainingObstructingTrips.length > 0) {
                            const pickupOverlapGaps = [];
                            const destinationOverlapGaps = [];

                            const potentialTripData = await getOldTripData(member.trip_id);
                            for (const obstructingTrip of remainingObstructingTrips) {
                              const obstructingTripData = await getOldTripData(obstructingTrip.trip_id);


                              const pickupDistance = potentialTripData[0].potential_trips.find(
                                (trip) => trip.trip_id === obstructingTripData[0].trip_id,
                              ).pickup_distance;

                              const destinationDistance = potentialTripData[0].potential_trips.find(
                                (trip) => trip.trip_id === obstructingTripData[0].trip_id,
                              ).destination_distance;

                              const pickupOverlapGap = 150 - (member.pickup_radius + obstructingTripData[0].pickup_radius - pickupDistance);
                              const destinationOverlapGap = 150 - (member.destination_radius + obstructingTripData[0].destination_radius - destinationDistance);

                              pickupOverlapGaps.push(pickupOverlapGap > 0 ? pickupOverlapGap : "N/A");
                              destinationOverlapGaps.push(destinationOverlapGap > 0 ? destinationOverlapGap : "N/A");
                            }

                            const largestPickupOverlapGap = Math.max(...pickupOverlapGaps.filter((gap) => gap !== "N/A"));
                            const largestDestinationOverlapGap = Math.max(...destinationOverlapGaps.filter((gap) => gap !== "N/A"));

                            await potentialTripData[1].update({
                              potential_trips: potentialTripData[0].potential_trips.map((trip) => {
                                if (tripGroupData.trip_group_members.some((groupMember) => groupMember.trip_id === trip.trip_id)) {
                                  return {
                                    ...trip,
                                    group_largest_pickup_overlap_gap: largestPickupOverlapGap !== -Infinity ? largestPickupOverlapGap : "N/A",
                                    group_largest_destination_overlap_gap: largestDestinationOverlapGap !== -Infinity ? largestDestinationOverlapGap : "N/A",
                                  };
                                }
                                return trip;
                              }),
                            });
                          }
                          const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                          if (member.seat_count <= tripGroupData.total_seat_count) {
                            seatObstruction = false;
                          } else seatObstruction = true;
                      }
                    }
                  } else {
                    tripObstruction = false;
                    unknownTripObstruction = false;
                    const tripGroupData = await getTripGroupData(newTripData.trip_group_id);
                    if (member.seat_count <= tripGroupData.total_seat_count) {
                      seatObstruction = false;
                    } else seatObstruction = true;
                  }
                  await db.collection("trip_groups").doc(newTripData.trip_group_id).update({
                    potential_trip_members: tripGroupData.potential_trip_members.map((trip) => {
                      if (member.trip_id === trip.trip_id) {
                        return {
                          ...trip,
                          trip_obstruction: tripObstruction,
                          unknown_trip_obstruction: unknownTripObstruction,
                          seat_obstruction: seatObstruction,
                        };
                      }
                      return trip;
                    }),
                  });
                  if (tripObstruction && seatObstruction) {
                    const potentialTripData = await getOldTripData(member.trip_id);

                    // Delete all indexes containing the remaining trip_group_members of the canceled trip from potential_trip array
                    const updatedPotentialTrips = potentialTripData[0].potential_trips.filter(
                      (trip) => !tripGroupData.trip_group_members.some((groupMember) => groupMember.trip_id === trip.trip_id),
                    );

                    // Add each of the remaining trip_group_members to matched_trips array
                    const updatedMatchedTrips = [
                      ...potentialTripData[0].matched_trips,
                      ...potentialTripData[0].potential_trips.filter(
                        (trip) => tripGroupData.trip_group_members.some((member) => member.trip_id === trip.trip_id),
                      ).map((groupMember) => ({
                        trip_id: groupMember.trip_id,
                        paid: true,
                        trip_group_id: groupMember.trip_group_id,
                        pickup_radius: groupMember.pickup_radius,
                        destination_radius: groupMember.destination_radius,
                        pickup_distance: groupMember.pickup_distance,
                        destination_distance: groupMember.destination_distance,
                        mutual: !groupMember.mutual,
                        reserving: false,
                      })),
                    ];

                    // Update the potential_trip document
                    await potentialTripData[1].update({
                      potential_trips: updatedPotentialTrips,
                      matched_trips: updatedMatchedTrips,
                    });

                    const tripGroupData = await getTripGroupData(newTripData.trip_group_id);

                    for (const member of tripGroupData.trip_group_members) {
                      const memberData = await getOldTripData(member.trip_id);

                      const updatedPotentialTrips = memberData[0].potential_trips.map((trip) => {
                        if (trip.trip_id === member.trip_id) {
                          return {
                            ...trip,
                            mutual: !trip.mutual,
                          };
                        }
                        return trip;
                      });

                      const updatedMatchedTrips = memberData[0].matched_trips.map((trip) => {
                        if (trip.trip_id === member.trip_id) {
                          return {
                            ...trip,
                            mutual: !trip.mutual,
                          };
                        }
                        return trip;
                      });

                      await memberData[1].update({
                        potential_trips: updatedPotentialTrips,
                        matched_trips: updatedMatchedTrips,
                      });
                    }
                  } else {
                    const potentialTripData = await getOldTripData(member.trip_id);

                    const updatedPotentialTrips = potentialTripData[0].potential_trips.map((trip) => {
                      if (tripGroupData.trip_group_members.some((groupMember) => groupMember.trip_id === trip.trip_id)) {
                        return {
                          ...trip,
                          trip_obstruction: tripObstruction,
                          unknown_trip_obstruction: unknownTripObstruction,
                          seat_obstruction: seatObstruction,
                        };
                      }
                      return trip;
                    });

                    await potentialTripData[1].update({
                      potential_trips: updatedPotentialTrips,
                    });
                  }
                }
            }
          } else {
            // Check if the canceled trip has any paid potential_trip or paid matched_trip
            if (newTripData.potential_trips && newTripData.potential_trips.some((trip) => trip.paid)) {
                // Handle the case where there is a paid potential_trip
                for (const potentialTrip of newTripData.potential_trips) {
                    if (potentialTrip.paid) {
                      const potentialTripData = getOldTripData(potentialTrip.trip_id)[0];

                      // Get all distinct trip groups from the potential trip
                      const tripGroups = [...new Set(potentialTripData.trip_group_id)];

                      for (const tripGroupId of tripGroups) {
                        const tripGroupRef = db.collection("trip_groups").doc(tripGroupId);
                        const tripGroupDoc = await tripGroupRef.get();

                        if (tripGroupDoc.exists) {
                          const tripGroupData = tripGroupDoc.data();

                          // Remove the canceled trip from potential_trip_members array
                          const updatedPotentialTripMembers = tripGroupData.potential_trip_members.filter(
                            (member) => member.trip_id !== tripId,
                          );

                          await tripGroupRef.update({
                            potential_trip_members: updatedPotentialTripMembers,
                          });
                        }
                      }
                    }
                }
            }

            if (newTripData.matched_trips && newTripData.matched_trips.some((trip) => trip.paid)) {
                // Handle the case where there is a paid matched_trip
                for (const matchedTrip of newTripData.matched_trips) {
                    if (matchedTrip.paid) {
                      const matchedTripData = getOldTripData(matchedTrip.trip_id)[0];

                      // Get all distinct trip groups from the potential trip
                      const tripGroups = [...new Set(matchedTripData.trip_group_id)];

                      for (const tripGroupId of tripGroups) {
                        const tripGroupRef = db.collection("trip_groups").doc(tripGroupId);
                        const tripGroupDoc = await tripGroupRef.get();

                        if (tripGroupDoc.exists) {
                          const tripGroupData = tripGroupDoc.data();

                          // Remove the canceled trip from potential_trip_members array
                          const updatedPotentialTripMembers = tripGroupData.potential_trip_members.filter(
                            (member) => member.trip_id !== tripId,
                          );

                          await tripGroupRef.update({
                            potential_trip_members: updatedPotentialTripMembers,
                          });
                        }
                      }
                    }
                }
            }
          }

        return null;
      } catch (error) {
        console.error("Error in tripCanceledFunction:", error);
        throw error;
      }
    });
