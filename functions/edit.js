/* eslint-disable no-empty */
/* eslint-disable linebreak-style */
/* eslint-disable indent */
/* eslint-disable max-len */
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const axios = require("axios");
const { get } = require("http");

const db = require("./firebaseAdmin");

exports.tripEditedFunction = onDocumentUpdated("users/{userId}/trips/{tripId}",
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
        const previousData = snapshot.before.data();

        const isProperMatch = (potentialTrip, newTripData) => {
            return (
                newTripData.pickup_radius + potentialTrip.pickup_radius >= 150 &&
                newTripData.destination_radius + potentialTrip.destination_radius >= 150
            );
        };

        const increaseTicketCount = async (userId) => {
            const userRef = db.collection( "users").doc(userId);
            const userDoc = await userRef.get();

            if (userDoc.exists) {
                const currentTicketCount = userDoc.data().ticket_count || 0;
                await userRef.update({
                    ticket_count: currentTicketCount + 1,
                });
            }
        };

        const getOldTripData = async (userId, tripId) => {
            try {
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
            } catch (error) {
                console.error("Error in getOldTripData:", error);
                return null;
            }
        };

        const updatePotentialTrips = async (potentialTripsArray, tripBeingAdded, tripToBeUpdatedDocRef, info) => {
            potentialTripsArray.push({
                ...info,
                trip_id: tripBeingAdded.trip_id,
                pickup_radius: tripBeingAdded.pickup_radius,
                destination_radius: tripBeingAdded.destination_radius,
                pickup_distance: tripBeingAdded.pickup_distance,
                destination_distance: tripBeingAdded.destination_distance,
            });

            await tripToBeUpdatedDocRef.update({
                potential_trips: potentialTripsArray,
            });
        };

        const removeMatchedTripAndUpdatePotentialTrips = async (tripToBeUpdatedMatchedTrips, tripToBeUpdatedPotentialTrips, tripToBeRemoved, tripToBeUpdatedDocRef, info) => {
            const matchedTripBeingRemoved = tripToBeUpdatedMatchedTrips.find(
                (mt) => mt.trip_id === tripToBeRemoved.trip_id,
            );
            const updatedMatchedTrips = tripToBeUpdatedMatchedTrips.filter(
                (mt) => mt.trip_id !== tripToBeRemoved.trip_id,
            );
            const updatedPotentialTrips = tripToBeUpdatedPotentialTrips || [];
            updatedPotentialTrips.push({
                ...info,
                trip_id: tripToBeRemoved.trip_id,
                pickup_radius: matchedTripBeingRemoved.pickup_radius,
                destination_radius: matchedTripBeingRemoved.destination_radius,
                pickup_distance: matchedTripBeingRemoved.pickup_distance,
                destination_distance: matchedTripBeingRemoved.destination_distance,
            });

            await tripToBeUpdatedDocRef.update({
                matched_trips: updatedMatchedTrips,
                potential_trips: updatedPotentialTrips,
            });

            return [updatedPotentialTrips, updatedMatchedTrips];
        };

        const updateMatchedTrips = async (matchedTripsArray, tripBeingAdded, info, tripToBeUpdatedDocRef) => {
            matchedTripsArray.push({
                ...info,
                trip_id: tripBeingAdded.trip_id,
                pickup_radius: tripBeingAdded.pickup_radius,
                destination_radius: tripBeingAdded.destination_radius,
                pickup_distance: tripBeingAdded.pickup_distance,
                destination_distance: tripBeingAdded.destination_distance,
            });

            await tripToBeUpdatedDocRef.update({
                potential_trips: matchedTripsArray,
            });
        };

        const removePotentialTripAndUpdateMatchedTrips = async (tripToBeUpdatedMatchedTrips, tripToBeUpdatedPotentialTrips, tripToBeRemoved, tripToBeUpdatedDocRef, info) => {
            const potentialTripBeingRemoved = tripToBeUpdatedPotentialTrips.find(
                (mt) => mt.trip_id === tripToBeRemoved.trip_id,
            );
            const updatedPotentialTrips = tripToBeUpdatedPotentialTrips.filter(
                (mt) => mt.trip_id !== tripToBeRemoved.trip_id,
            );
            const updatedMatchedTrips = tripToBeUpdatedMatchedTrips || [];
            updatedPotentialTrips.push({
                ...info,
                trip_id: potentialTripBeingRemoved.trip_id,
                pickup_radius: potentialTripBeingRemoved.pickup_radius,
                destination_radius: potentialTripBeingRemoved.destination_radius,
                pickup_distance: potentialTripBeingRemoved.pickup_distance,
                destination_distance: potentialTripBeingRemoved.destination_distance,
            });

            await tripToBeUpdatedDocRef.update({
                matched_trips: updatedMatchedTrips,
                potential_trips: updatedPotentialTrips,
            });

            return [updatedPotentialTrips, updatedMatchedTrips];
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

        let matched = false;

        console.log(`Trip ${tripId} matched status: ${matched}`);
        let reserved = false;


        console.log(`Trip ${tripId} reserved status: ${reserved}`);

        let newlyReservedTripId = "";

        if (newTripData.reserved) {
            const oldTripData = await getOldTripData(newTripData.reserving_trip_user_id, newTripData.reserving_trip_id);
            if (isProperMatch(newTripData, oldTripData[0])) {
                matched = true;
                reserved = true;
                console.log(`Trip ${tripId} has been matched.`);
            } else {
                const reservingTripToBeRemoved = newTripData.matched_trips.find(
                    (matchedTrip) => matchedTrip.trip_id === newTripData.reserving_trip_id,
                );
                const updatedEditedTripMatchedTrips = newTripData.matched_trips.filter(
                    (mt) => mt.trip_id !== newTripData.reserving_trip_id,
                );
                await snapshot.after.ref.update({
                    matched_trips: updatedEditedTripMatchedTrips,
                    reserved: false,
                    reserving_trip_id: db.FieldValue.delete(),
                });
                // const updatedReservingTripMatchedTrips = oldTripData[0].matched_trips.filter(
                //     (mt) => mt.trip_id !== tripId,
                // );

                const [updatedReservingTripPotentialTrips, updatedReservingTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(oldTripData[0].matched_trips, oldTripData[0].potential_trips, newTripData, oldTripData[1], {
                    paid: false,
                    trip_group_id: null,
                    proper_match: false,
                    trip_obstruction: false,
                    seat_obstruction: false,
                    reserving_trip_obstruction: false,
                    mutual: true,
                    group_largest_pickup_overlap_gap: null,
                    group_largest_destination_overlap_gap: null,
                    unknown_trip_obstruction: null,
                    total_seat_count: null,
                });

                // check if edited trip's reserving trip has any other matched trips
                if (updatedReservingTripMatchedTrips.length > 0) {
                    const updatedEditedTripPotentialTrips = newTripData.potential_trips || [];
                    updatePotentialTrips(updatedEditedTripPotentialTrips, reservingTripToBeRemoved, snapshot.after.ref, {paid: true,
                        trip_group_id: reservingTripToBeRemoved.trip_group_id,
                        proper_match: false,
                        trip_obstruction: true,
                        seat_obstruction: false,
                        reserving_trip_obstruction: false,
                        mutual: true,
                        group_largest_pickup_overlap_gap: isProperMatch(newTripData, reservingTripToBeRemoved) ? null : reservingTripToBeRemoved.group_largest_pickup_overlap_gap,
                        group_largest_destination_overlap_gap: isProperMatch(newTripData, reservingTripToBeRemoved) ? null : reservingTripToBeRemoved.group_largest_destination_overlap_gap,
                        unknown_trip_obstruction: false,
                        total_seat_count: reservingTripToBeRemoved.total_seat_count});

                    const nearestTrips = updatedReservingTripMatchedTrips.reduce((nearest, currentTrip) => {
                        const currentPickupDistance = currentTrip.pickup_distance;
                        const currentDestinationDistance = currentTrip.destination_distance;
                        const currentCombinedDistance = currentPickupDistance + currentDestinationDistance;

                        if (!nearest.length || currentCombinedDistance < nearest[0].combinedDistance) {
                            return [{
                                trip: currentTrip,
                                combinedDistance: currentCombinedDistance,
                            }];
                        } else if (currentCombinedDistance === nearest[0].combinedDistance) {
                            nearest.push({
                                trip: currentTrip,
                                combinedDistance: currentCombinedDistance,
                            });
                        }
                        return nearest;
                    }, []);

                    const nearestTrip = nearestTrips.length > 0 ? nearestTrips[Math.floor(Math.random() * nearestTrips.length)] : null;

                    if (nearestTrip) {
                        newlyReservedTripId = nearestTrip.trip.trip_id;
                        const nearestTripData = await getOldTripData(userId, newlyReservedTripId);
                        await nearestTripData[1].update({
                            reserved: true,
                            reserving_trip_id: reservingTripToBeRemoved.trip_id,
                        });

                        newlyReservedTripId = nearestTrip.trip.trip_id;
                    }
                    const updatedMatchedTrips = updatedReservingTripMatchedTrips.map((matchedTrip) => {
                        if (matchedTrip.trip_id === newlyReservedTripId) {
                            return {
                                ...matchedTrip,
                                reserving: true,
                            };
                        }
                        return matchedTrip;
                    });

                    await oldTripData[1].update({
                        matched_trips: updatedMatchedTrips,
                    });

                    // Newly reserved trips that do not proper match the edited trip's former reserving trip
                    const newlyReservedTripData = await getOldTripData(userId, newlyReservedTripId);

                    const newlyReservedTripsMatchedPotentialTripsDontProperMatch = newlyReservedTripData[0].matched_trips.filter(
                        (trip) => trip.mutual === true && !isProperMatch(trip, oldTripData[0]),
                    ).concat(
                        newlyReservedTripData[0].potential_trips.filter(
                            (trip) => trip.mutual === false && !isProperMatch(trip, oldTripData[0]),
                        ),
                    );
                    for (const trip of newlyReservedTripsMatchedPotentialTripsDontProperMatch) {
                        const tripData = await getOldTripData(trip.user_id, trip.trip_id);
                        // Delete the element containing the newly reserved trip from matched trips array
                        const tripToBeRemoved = tripData[0].matched_trips.find(
                            (matchedTrip) => matchedTrip.trip_id === newlyReservedTripId,
                        );
                        await removeMatchedTripAndUpdatePotentialTrips(tripData[0].matched_trips, tripData[0].potential_trips, tripToBeRemoved, tripData[1], {
                            trip_id: newlyReservedTripId,
                            paid: false,
                            trip_group_id: null,
                            proper_match: true,
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: true,
                            mutual: !trip.mutual,
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: false,
                            total_seat_count: null,
                        });

                        // Check if the trip is in newlyReservedTrip matched_trips or potential_trips
                        const newlyReservedTripMatchedTrip = newlyReservedTripData[0].matched_trips.find(
                            (matchedTrip) => matchedTrip.trip_id === trip.trip_id,
                        );
                        const newlyReservedTripPotentialTrip = newlyReservedTripData[0].potential_trips.find(
                            (potentialTrip) => potentialTrip.trip_id === trip.trip_id,
                        );

                        if (newlyReservedTripMatchedTrip) {
                            // Update the mutual property of the matched trip
                            const updatedMatchedTrips = newlyReservedTripData[0].matched_trips.map((matchedTrip) => {
                                if (matchedTrip.trip_id === trip.trip_id) {
                                    return {
                                        ...matchedTrip,
                                        mutual: !matchedTrip.mutual,
                                    };
                                }
                                return matchedTrip;
                            });

                            await newlyReservedTripData[1].update({
                                matched_trips: updatedMatchedTrips,
                            });
                        }

                        if (newlyReservedTripPotentialTrip) {
                            // Update the mutual property of the potential trip
                            const updatedPotentialTrips = newlyReservedTripData[0].potential_trips.map((potentialTrip) => {
                                if (potentialTrip.trip_id === trip.trip_id) {
                                    return {
                                        ...potentialTrip,
                                        mutual: !potentialTrip.mutual,
                                    };
                                }
                                return potentialTrip;
                            });

                            await newlyReservedTripData[1].update({
                                potential_trips: updatedPotentialTrips,
                            });
                        }

                        if (tripData[0].matched_trips.length === 1 && tripData[0].matched_trips[0].trip_id === newlyReservedTripId) {
                            await tripData[1].update({
                                status: "unmatched",
                            });
                        }
                    }
                } else {
                    // Delete the former reserving trip’s trip group document
                    if (oldTripData[0].trip_group_id) {
                        await deleteTripGroup(oldTripData[0].trip_group_id);
                    }
                    const updatedEditedTripPotentialTrips = newTripData.potential_trips || [];
                    updatePotentialTrips(updatedEditedTripPotentialTrips, reservingTripToBeRemoved, snapshot.after.ref, {paid: false,
                        trip_group_id: null,
                        proper_match: false,
                        trip_obstruction: false,
                        seat_obstruction: false,
                        reserving_trip_obstruction: false,
                        mutual: true,
                        group_largest_pickup_overlap_gap: null,
                        group_largest_destination_overlap_gap: null,
                        unknown_trip_obstruction: null,
                        total_seat_count: null});

                    await oldTripData[1].update({
                        status: "unmatched",
                        trip_group_id: db.FieldValue.delete(),
                        payment_time: db.FieldValue.delete(),
                        total_seat_count: db.FieldValue.delete(),
                    });
                    increaseTicketCount(oldTripData[0].user_id);

                    for (const potentialTrip of updatedReservingTripPotentialTrips) {
                        const potentialTripData = await getOldTripData(potentialTrip.user_id, potentialTrip.trip_id);
                        const updatedPotentialTrips = potentialTripData[0].potential_trips.map((trip) => {
                            if (trip.trip_id === tripId) {
                                return {
                                    ...trip,
                                    paid: false,
                                    trip_group_id: db.FieldValue.delete(),
                                    trip_obstruction: false,
                                    group_largest_pickup_overlap_gap: db.FieldValue.delete(),
                                    group_largest_destination_overlap_gap: db.FieldValue.delete(),
                                    total_seat_count: db.FieldValue.delete(),
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
        }
        if (newTripData.pickup_radius !== previousData.pickup_radius || newTripData.destination_radius !== previousData.destination_radius) {
            console.log("Changes detected in pickup_radius or destination_radius");
            const editedTripUnpaidMatchedTrips = newTripData.matched_trips.filter(
                (matchedTrip) => !matchedTrip.paid,
            );
            const updatedNewTripData = await getOldTripData(userId, tripId);

            if (editedTripUnpaidMatchedTrips) {
                for (const matchedTrip of editedTripUnpaidMatchedTrips) {
                    const matchedTripData = await getOldTripData(matchedTrip.user_id, matchedTrip.trip_id);
                    if (!isProperMatch(newTripData, matchedTripData[0])) {
                        if (matchedTripData[0].trip_id !== newlyReservedTripId) {
                           if (matchedTripData[0].reserved) {
                            const reservingTrip = await getOldTripData(matchedTripData[0].reserving_trip_user_id, matchedTripData[0].reserving_trip_id);
                            if (isProperMatch(reservingTrip[0], newTripData)) {
                                const matchedTripBeingRemoved = updatedNewTripData[0].matched_trips.find(
                                    (mt) => mt.trip_id === matchedTripData[0].trip_id,
                                );
                                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(updatedNewTripData[0].matched_trips, updatedNewTripData[0].potential_trips, matchedTripBeingRemoved, snapshot.after.ref, {
                                    paid: false,
                                    trip_group_id: null,
                                    proper_match: false,
                                    trip_obstruction: false,
                                    seat_obstruction: false,
                                    reserving_trip_obstruction: false,
                                    mutual: true,
                                    group_largest_pickup_overlap_gap: null,
                                    group_largest_destination_overlap_gap: null,
                                    unknown_trip_obstruction: false,
                                    total_seat_count: null,
                                });
                            }
                           } else {
                                const matchedTripBeingRemoved = updatedNewTripData[0].matched_trips.find(
                                    (mt) => mt.trip_id === matchedTripData[0].trip_id,
                                );
                                const updatedMatchedTripsForEditedTrip = updatedNewTripData[0].matched_trips.filter(
                                    (mt) => mt.trip_id !== matchedTripData[0].trip_id,
                                );
                                const updatedPotentialTripsForEditedTrip = updatedNewTripData[0].potential_trips || [];
                                updatedPotentialTripsForEditedTrip.push({
                                    trip_id: matchedTripBeingRemoved.trip_id,
                                    paid: false,
                                    trip_group_id: null,
                                    pickup_radius: matchedTripBeingRemoved.pickup_radius,
                                    destination_radius: matchedTripBeingRemoved.destination_radius,
                                    pickup_distance: matchedTripBeingRemoved.pickup_distance,
                                    destination_distance: matchedTripBeingRemoved.destination_distance,
                                    proper_match: false,
                                    trip_obstruction: false,
                                    seat_obstruction: false,
                                    reserving_trip_obstruction: false,
                                    mutual: true,
                                    group_largest_pickup_overlap_gap: null,
                                    group_largest_destination_overlap_gap: null,
                                    unknown_trip_obstruction: false,
                                    total_seat_count: null,
                                });

                                await snapshot.after.ref.update({
                                    matched_trips: updatedMatchedTripsForEditedTrip,
                                    potential_trips: updatedPotentialTripsForEditedTrip,
                                });
                           }
                        } else {

                        }

                        const updatedMatchedTrips = newTripData.matched_trips.filter(
                            (mt) => mt.trip_id !== matchedTrip.trip_id,
                        );
                        const updatedPotentialTrips = newTripData.potential_trips || [];
                        updatedPotentialTrips.push({
                            trip_id: matchedTrip.trip_id,
                            paid: false,
                            trip_group_id: null,
                            pickup_radius: matchedTrip.pickup_radius,
                            destination_radius: matchedTrip.destination_radius,
                            pickup_distance: matchedTrip.pickup_distance,
                            destination_distance: matchedTrip.destination_distance,
                            proper_match: false,
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: false,
                            mutual: true,
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: null,
                            total_seat_count: null,
                        });

                        await snapshot.after.ref.update({
                            matched_trips: updatedMatchedTrips,
                            potential_trips: updatedPotentialTrips,
                        });

                        const updatedMatchedTripsForMatchedTrip = matchedTripData[0].matched_trips.filter(
                            (mt) => mt.trip_id !== tripId,
                        );
                        const updatedPotentialTripsForMatchedTrip = matchedTripData[0].potential_trips || [];
                        updatedPotentialTripsForMatchedTrip.push({
                            trip_id: tripId,
                            paid: false,
                            trip_group_id: null,
                            pickup_radius: newTripData.pickup_radius,
                            destination_radius: newTripData.destination_radius,
                            pickup_distance: newTripData.pickup_distance,
                            destination_distance: newTripData.destination_distance,
                            proper_match: false,
                            trip_obstruction: false,
                            seat_obstruction: false,
                            reserving_trip_obstruction: false,
                            mutual: true,
                            group_largest_pickup_overlap_gap: null,
                            group_largest_destination_overlap_gap: null,
                            unknown_trip_obstruction: null,
                            total_seat_count: null,
                        });

                        await matchedTripData[1].update({
                            matched_trips: updatedMatchedTripsForMatchedTrip,
                            potential_trips: updatedPotentialTripsForMatchedTrip,
                        });
                    }
                }
            }
        } else {
            console.log("No changes detected in pickup_radius or destination_radius");
        }
        return null;
      } catch (error) {
        console.error("Error in tripCanceledFunction:", error);
        throw error;
      }
    });
