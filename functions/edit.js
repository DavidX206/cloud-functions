/* eslint-disable linebreak-style */
/* eslint-disable no-empty */
/* eslint-disable camelcase */
/* eslint-disable indent */
/* eslint-disable max-len */
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");

const {db, del} = require("./firebaseAdmin");

exports.tripEditedFunction = onDocumentUpdated("users/{userId}/trips/{tripId}",
    async (event) => {
      try {
        // const userId = event.params.userId;
        const tripId = event.params.tripId;
        const snapshot = event.data;

        if (!snapshot) {
          console.log("No data associated with the event");
          return;
        }

        const newTripData = snapshot.after.data();
        const previousData = snapshot.before.data();

        const isProperMatch = (trip1Data, trip2) => {
            const isPotentialAndProperMatch = trip1Data.potential_trips.some((potentialTrip) => potentialTrip.trip_id === trip2.trip_id && potentialTrip.proper_match === true);

            const isMatched = trip1Data.matched_trips.some((potentialTrip) => potentialTrip.trip_id === trip2.trip_id);

            return (isPotentialAndProperMatch || isMatched);
        };

        const isProperMatchDefunct = (potentialTrip, newTripData, pickupDistance, destinationDistance) => {
            const isPickupWithinRadius = pickupDistance <= newTripData.pickup_radius && pickupDistance <= potentialTrip.pickup_radius;
            const isDestinationWithinRadius = destinationDistance <= newTripData.destination_radius && destinationDistance <= potentialTrip.destination_radius;
            return isPickupWithinRadius && isDestinationWithinRadius;
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

        const getOldTripData = async (tripId, userId) => {
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

        const removeMatchedTripAndUpdatePotentialTrips = async (tripToBeUpdatedMatchedTrips, tripToBeUpdatedPotentialTrips, tripToBeRemoved, info) => {
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

            return [updatedPotentialTrips, updatedMatchedTrips];
        };

        const removePotentialTripAndUpdateMatchedTrips = async (tripToBeUpdatedMatchedTrips, tripToBeUpdatedPotentialTrips, tripToBeRemoved, info) => {
            const potentialTripBeingRemoved = tripToBeUpdatedPotentialTrips.find(
                (mt) => mt.trip_id === tripToBeRemoved.trip_id,
            );
            const updatedPotentialTrips = tripToBeUpdatedPotentialTrips.filter(
                (mt) => mt.trip_id !== tripToBeRemoved.trip_id,
            );
            const updatedMatchedTrips = tripToBeUpdatedMatchedTrips || [];
            updatedMatchedTrips.push({
                ...info,
                trip_id: potentialTripBeingRemoved.trip_id,
                pickup_radius: potentialTripBeingRemoved.pickup_radius,
                destination_radius: potentialTripBeingRemoved.destination_radius,
                pickup_distance: potentialTripBeingRemoved.pickup_distance,
                destination_distance: potentialTripBeingRemoved.destination_distance,
            });

            return [updatedPotentialTrips, updatedMatchedTrips];
        };

        const getDistinctPaidTripGroups = async (paidTrips) => {
            // const matched_trips = await getTripMatchedTrips();

            if (paidTrips.length === 0) {
                console.log("No paid trips found.");
                return [];
            }

            const processedTripIds = new Set();
            const distinctTripGroups = [];

            for (const trip of paidTrips) {
                const {trip_group_id, trip_id} = trip;
                const tripGroupDocRef = db.collection("trip_groups").doc(trip_group_id);
                const tripGroupDoc = await tripGroupDocRef.get();

                if (!tripGroupDoc.exists) {
                    console.log(`Trip group with ID ${trip_group_id} does not exist.`);
                    continue;
                }

                const tripGroupData = tripGroupDoc.data();
                const tripMembers = tripGroupData.trip_group_members || [];

                const hasDuplicate = tripMembers.some((member) => processedTripIds.has(member.trip_id));

                if (!hasDuplicate) {
                    distinctTripGroups.push(tripGroupData);
                    processedTripIds.add(trip_id);
                }
            }

            return distinctTripGroups;
        };

        const deleteTripGroup = async (tripGroupId) => {
          // Delete the trip group document
          await db.collection("trip_groups").doc(tripGroupId).delete();
        };

        const calculatePickupOverlapGapWithET = async (trip, et) => {
            let tripData = trip;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            const pickupDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === et.trip_id,
              ).pickup_distance;
            const pickupOverlapGap = 150 - (tripData.pickup_radius + et.pickup_radius - pickupDistance);
            return pickupOverlapGap >= 0 ? pickupOverlapGap : null;
        };

        const calculateDestinationOverlapGapWithET = async (trip, et) => {
            let tripData = trip;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            const destinationDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === et.trip_id,
              ).destination_distance;
            const destinationOverlapGap = 150 - (tripData.destination_radius + et.destination_radius - destinationDistance);
            return destinationOverlapGap >= 0 ? destinationOverlapGap : null;
        };

        const calculateOverlapGap = (choiceTripGroupData) => {
            const obstructingTripMembers = [];
            const pickupOverlapGaps = [];
            const destinationOverlapGaps = [];

            for (const member of choiceTripGroupData.potential_trips_members) {
                const obstructingTrip = member.obstructing_trip_members.filter(
                    (obstructingTrip) => obstructingTrip.unknown === false,
                );
                obstructingTripMembers.push(obstructingTrip);
            }

            for (const obstructingTrip of obstructingTripMembers) {
                pickupOverlapGaps.push(obstructingTrip.pickup_overlap_gap > 0 ? obstructingTrip.pickup_overlap_gap : "N/A");
                destinationOverlapGaps.push(obstructingTrip.destination_overlap_gap > 0 ? obstructingTrip.destination_overlap_gap : "N/A");
              }
            const largestPickupOverlapGap = Math.max(...pickupOverlapGaps.filter((gap) => gap !== "N/A"));
            const largestDestinationOverlapGap = Math.max(...destinationOverlapGaps.filter((gap) => gap !== "N/A"));
            return [largestPickupOverlapGap, largestDestinationOverlapGap];
        };

        let matched = false;

        console.log(`Trip ${tripId} matched status: ${matched}`);
        let reserved = false;


        console.log(`Trip ${tripId} reserved status: ${reserved}`);

        let newlyReservedTripId = "";
        const distinctTripGroups = [];
        let tripGroupsInfo = [];
        let editedMatchedTrips;
        let editedPotentialTrips;

        if (newTripData.reserved) {
            const oldTripData = await getOldTripData(newTripData.reserving_trip_id, newTripData.reserving_trip_user_id);
            if (isProperMatch(newTripData, oldTripData[0])) {
                matched = true;
                reserved = true;
            } else {
                const [updatedReservingTripPotentialTrips, updatedReservingTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(oldTripData[0].matched_trips, oldTripData[0].potential_trips, newTripData, {
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

                await oldTripData[1].update({
                    matched_trips: updatedReservingTripMatchedTrips,
                    potential_trips: updatedReservingTripPotentialTrips,
                });

                const reservingTripToBeRemoved = newTripData.matched_trips.find(
                    (matchedTrip) => matchedTrip.trip_id === newTripData.reserving_trip_id,
                );
                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(newTripData.matched_trips, newTripData.potential_trips, oldTripData[0], {
                    paid: updatedReservingTripMatchedTrips.length>0 ? true : false,
                    trip_group_id: updatedReservingTripMatchedTrips.length>0 ? oldTripData[0].trip_group_id : null,
                    proper_match: false,
                    trip_obstruction: updatedReservingTripMatchedTrips.length>0 ? true : false,
                    seat_obstruction: false,
                    reserving_trip_obstruction: false,
                    mutual: true,
                    group_largest_pickup_overlap_gap: (isProperMatch(newTripData, reservingTripToBeRemoved) || updatedReservingTripMatchedTrips.length===0) ? null : reservingTripToBeRemoved.group_largest_pickup_overlap_gap, // check for issue
                    group_largest_destination_overlap_gap: (isProperMatch(newTripData, reservingTripToBeRemoved) || updatedReservingTripMatchedTrips.length===0) ? null : reservingTripToBeRemoved.group_largest_destination_overlap_gap,
                    unknown_trip_obstruction: updatedReservingTripMatchedTrips.length>0 ? false : null,
                    total_seat_count: updatedReservingTripMatchedTrips.length>0 ? oldTripData[0].seat_count : null,
                });

                editedMatchedTrips = updatedEditedTripMatchedTrips;
                editedPotentialTrips = updatedEditedTripPotentialTrips;

                await snapshot.after.ref.update({
                    matched_trips: updatedEditedTripMatchedTrips,
                    potential_trips: updatedEditedTripPotentialTrips,
                    reserved: false,
                    reserving_trip_id: del(),
                });
                // const updatedReservingTripMatchedTrips = oldTripData[0].matched_trips.filter(
                //     (mt) => mt.trip_id !== tripId,
                // );


                // check if edited trip's reserving trip has any other matched trips
                if (updatedReservingTripMatchedTrips.length > 0) {
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
                        const nearestTripData = await getOldTripData(newlyReservedTripId, nearestTrip.trip.user_id);
                        await nearestTripData[1].update({
                            reserved: true,
                            reserving_trip_id: reservingTripToBeRemoved.trip_id,
                            reserving_trip_user_id: reservingTripToBeRemoved.user_id,
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
                    const newlyReservedTripData = await getOldTripData(newlyReservedTripId, nearestTrip.trip.user_id);

                    const newlyReservedTripsMatchedPotentialTripsDontProperMatch = newlyReservedTripData[0].matched_trips.filter(
                        (trip) => trip.mutual === true && !isProperMatch(oldTripData[0], trip),
                    ).concat(
                        newlyReservedTripData[0].potential_trips.filter(
                            (trip) => trip.mutual === false && !isProperMatch(oldTripData[0], trip),
                        ),
                    );

                    const newlyReservedTripsPotentialTripsDontProperMatch = newlyReservedTripData[0].matched_trips.filter(
                        (trip) => trip.mutual === false && !isProperMatch(oldTripData[0], trip),
                    ).concat(
                        newlyReservedTripData[0].potential_trips.filter(
                            (trip) => trip.mutual === true && !isProperMatch(oldTripData[0], trip),
                        ),
                    );
                    for (const trip of newlyReservedTripsMatchedPotentialTripsDontProperMatch) {
                        const tripData = await getOldTripData(trip.trip_id, trip.user_id);
                        // Delete the element containing the newly reserved trip from matched trips array
                        const tripToBeRemoved = tripData[0].matched_trips.find(
                            (matchedTrip) => matchedTrip.trip_id === newlyReservedTripId,
                        );
                        const [potentialTrips, matchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(tripData[0].matched_trips, tripData[0].potential_trips, tripToBeRemoved, {
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

                        await tripData[1].update({
                            matched_trips: matchedTrips,
                            potential_trips: potentialTrips,
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

                    for (const trip of newlyReservedTripsPotentialTripsDontProperMatch) {
                        const tripData = await getOldTripData(trip.trip_id, trip.user_id);
                        const updatedPotentialTrips = tripData[0].potential_trips.map((potentialTrip) => {
                            if (potentialTrip.trip_id === trip.trip_id) {
                                return {
                                    ...potentialTrip,
                                    reserving_trip_obstruction: true,
                                };
                            }
                            return potentialTrip;
                        });
                        await tripData[1].update({
                            potential_trips: updatedPotentialTrips,
                        });
                    }
                } else {
                    // Delete the former reserving trip’s trip group document
                    if (oldTripData[0].trip_group_id) {
                        await deleteTripGroup(oldTripData[0].trip_group_id);
                    }

                    await oldTripData[1].update({
                        status: "unmatched",
                        trip_group_id: del(),
                        payment_time: del(),
                        total_seat_count: del(),
                    });
                    await increaseTicketCount(oldTripData[0].user_id);

                    for (const potentialTrip of updatedReservingTripPotentialTrips) {
                        const potentialTripData = await getOldTripData(potentialTrip.trip_id. potentialTrip.user_id);
                        const updatedPotentialTrips = potentialTripData[0].potential_trips.map((trip) => {
                            if (trip.trip_id === tripId) {
                                return {
                                    ...trip,
                                    paid: false,
                                    trip_group_id: del(),
                                    trip_obstruction: false,
                                    group_largest_pickup_overlap_gap: del(),
                                    group_largest_destination_overlap_gap: del(),
                                    total_seat_count: del(),
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
            const editedTripUnpaidMatchedTrips = editedMatchedTrips.filter(
                (matchedTrip) => !matchedTrip.paid,
            );

            if (editedTripUnpaidMatchedTrips) {
                for (const matchedTrip of editedTripUnpaidMatchedTrips) {
                    const matchedTripData = await getOldTripData(matchedTrip.trip_id, matchedTrip.user_id);
                    const pickupDistance = editedMatchedTrips.find((trip) => trip.trip_id === matchedTripData[0].trip_id).pickup_distance;
                    const destinationDistance = editedMatchedTrips.find((trip) => trip.trip_id === matchedTripData[0].trip_id).destination_distance;
                    if (!isProperMatchDefunct(matchedTripData[0], newTripData, pickupDistance, destinationDistance)) {
                        if (matchedTripData[0].trip_id !== newlyReservedTripId) {
                           if (matchedTripData[0].reserved) {
                            const reservingTrip = await getOldTripData(matchedTripData[0].reserving_trip_id, matchedTripData[0].reserving_trip_user_id);
                            const pickupDistance = (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).pickup_distance;
                            const destinationDistance = (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).destination_distance;
                            if (isProperMatchDefunct(reservingTrip[0], newTripData, pickupDistance, destinationDistance)) {
                                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
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
                                editedMatchedTrips = updatedEditedTripMatchedTrips;
                                editedPotentialTrips = updatedEditedTripPotentialTrips;
                            } else {
                                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                                    paid: false,
                                    trip_group_id: null,
                                    proper_match: false,
                                    trip_obstruction: false,
                                    seat_obstruction: false,
                                    reserving_trip_obstruction: true,
                                    mutual: true,
                                    group_largest_pickup_overlap_gap: null,
                                    group_largest_destination_overlap_gap: null,
                                    unknown_trip_obstruction: false,
                                    total_seat_count: null,
                                });
                                editedMatchedTrips = updatedEditedTripMatchedTrips;
                                editedPotentialTrips = updatedEditedTripPotentialTrips;
                            }
                           } else {
                                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
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
                                editedMatchedTrips = updatedEditedTripMatchedTrips;
                                editedPotentialTrips = updatedEditedTripPotentialTrips;
                           }
                        } else {
                            const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                                paid: false,
                                trip_group_id: null,
                                proper_match: false,
                                trip_obstruction: false,
                                seat_obstruction: false,
                                reserving_trip_obstruction: true,
                                mutual: true,
                                group_largest_pickup_overlap_gap: null,
                                group_largest_destination_overlap_gap: null,
                                unknown_trip_obstruction: false,
                                total_seat_count: null,
                            });

                            editedMatchedTrips = updatedEditedTripMatchedTrips;
                            editedPotentialTrips = updatedEditedTripPotentialTrips;
                        }

                        if (matchedTrip.mutual) {
                            const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(matchedTripData[0].matched_trips, matchedTripData[0].potential_trips, newTripData, {
                                paid: false,
                                trip_group_id: null,
                                proper_match: false,
                                trip_obstruction: false,
                                seat_obstruction: false,
                                reserving_trip_obstruction: true,
                                mutual: true,
                                group_largest_pickup_overlap_gap: null,
                                group_largest_destination_overlap_gap: null,
                                unknown_trip_obstruction: false,
                                total_seat_count: null,
                            });

                            await matchedTripData[1].update({
                                matched_trips: updatedEditedTripMatchedTrips,
                                potential_trips: updatedEditedTripPotentialTrips,
                            });

                            if (matchedTripData[0].matched_trips.length === 1 && matchedTripData[0].matched_trips[0].trip_id === tripId) {
                                await matchedTripData[1].update({
                                    status: "unmatched",
                                });
                            }
                        } else {
                            const updatedPotentialTrips = matchedTripData[0].potential_trips.map((potentialTrip) => {
                                if (potentialTrip.trip_id === tripId) {
                                    return {
                                        ...potentialTrip,
                                        pickup_radius: newTripData.pickup_radius,
                                        destination_radius: newTripData.destination_radius,
                                        proper_match: false,
                                        mutual: true,
                                        reserving_trip_obstruction: reserved ? true : false,
                                    };
                                }
                                return potentialTrip;
                            });
                            await matchedTripData[1].update({
                                potential_trips: updatedPotentialTrips,
                            });
                        }
                    } else {
                        if (matchedTripData[0].trip_id !== newlyReservedTripId) {
                            if (matchedTripData[0].reserved) {
                                const reservingTrip = await getOldTripData(matchedTripData[0].reserving_trip_id, matchedTripData[0].reserving_trip_user_id);
                                const pickupDistance = (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).pickup_distance;
                                const destinationDistance = (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).destination_distance;
                                if (isProperMatch(reservingTrip[0], newTripData, pickupDistance, destinationDistance)) {
                                    matched = true;
                                } else {
                                    const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                                        paid: false,
                                        trip_group_id: null,
                                        proper_match: true,
                                        trip_obstruction: false,
                                        seat_obstruction: false,
                                        reserving_trip_obstruction: true,
                                        mutual: (matchedTrip.mutual || reserved === false) ? false : true,
                                        group_largest_pickup_overlap_gap: null,
                                        group_largest_destination_overlap_gap: null,
                                        unknown_trip_obstruction: false,
                                        total_seat_count: null,
                                    });

                                    editedMatchedTrips = updatedEditedTripMatchedTrips;
                                    editedPotentialTrips = updatedEditedTripPotentialTrips;
                                }
                            } else {
                                matched = true;
                            }
                         } else {
                                const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                                    paid: false,
                                    trip_group_id: null,
                                    proper_match: true,
                                    trip_obstruction: false,
                                    seat_obstruction: false,
                                    reserving_trip_obstruction: true,
                                    mutual: matchedTrip.mutual ? false : true,
                                    group_largest_pickup_overlap_gap: null,
                                    group_largest_destination_overlap_gap: null,
                                    unknown_trip_obstruction: false,
                                    total_seat_count: null,
                                });

                                editedMatchedTrips = updatedEditedTripMatchedTrips;
                                editedPotentialTrips = updatedEditedTripPotentialTrips;
                         }

                         if (matchedTrip.mutual) {
                            const updatedMatchedTrips = matchedTripData[0].matched_trips.map((matchedTrip) => {
                                if (matchedTrip.trip_id === tripId) {
                                    return {
                                        ...matchedTrip,
                                        pickup_radius: newTripData.pickup_radius,
                                        destination_radius: newTripData.destination_radius,
                                        mutual: (matched === true || reserved === true) ? true : false,
                                    };
                                }
                                return matchedTrip;
                            });
                            await matchedTripData[1].update({
                                matched_trips: updatedMatchedTrips,
                            });
                         } else {
                                if (reserved === true) {
                                    const updatedPotentialTrips = matchedTripData[0].potential_trips.map((potentialTrip) => {
                                        if (potentialTrip.trip_id === tripId) {
                                            return {
                                                ...potentialTrip,
                                                pickup_radius: newTripData.pickup_radius,
                                                destination_radius: newTripData.destination_radius,
                                                mutual: true,
                                            };
                                        }
                                        return potentialTrip;
                                    });
                                    await matchedTripData[1].update({
                                        potential_trips: updatedPotentialTrips,
                                    });
                                } else {
                                    const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(matchedTripData[0].matched_trips, matchedTripData[0].potential_trips, newTripData, {
                                        paid: false,
                                        trip_group_id: null,
                                        mutual: matched === true ? true : false,
                                        reserving: false,
                                    });

                                    await matchedTripData[1].update({
                                        matched_trips: updatedEditedTripMatchedTrips,
                                        potential_trips: updatedEditedTripPotentialTrips,
                                    });
                                }
                         }
                    }
                }
            }
            const editedTripUnpaidPotentialTrips = editedPotentialTrips.filter(
                (potentialTrip) => !potentialTrip.paid,
            );
            if (editedTripUnpaidPotentialTrips) {
                for (const potentialTrip of editedTripUnpaidPotentialTrips) {
                    const potentialTripData = await getOldTripData(potentialTrip.trip_id, potentialTrip.user_id);
                    const pickupDistance = editedPotentialTrips.find((trip) => trip.trip_id === potentialTripData[0].trip_id).pickup_distance;
                    const destinationDistance = editedPotentialTrips.find((trip) => trip.trip_id === potentialTripData[0].trip_id).destination_distance;
                    if (!isProperMatchDefunct(potentialTripData[0], newTripData, pickupDistance, destinationDistance)) {
                        let editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                            if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                return {
                                    ...potentialTrip,
                                    proper_match: false,
                                };
                            }
                            return potentialTrip;
                        });

                        if (previousData.potential_trips.some((trip) => trip.trip_id === potentialTripData[0].trip_id && trip.proper_match === true)) {
                            const potentialTripReservingTrip = await getOldTripData(potentialTripData[0].reserving_trip_id, potentialTripData[0].reserving_trip_user_id);
                            const pickupDistance = (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === potentialTripReservingTrip[0].trip_id).pickup_distance;
                            const destinationDistance = (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === potentialTripReservingTrip[0].trip_id).destination_distance;

                            if (isProperMatchDefunct(potentialTripReservingTrip[0], newTripData, pickupDistance, destinationDistance)) {
                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                        return {
                                            ...potentialTrip,
                                            reserving_trip_obstruction: true,
                                        };
                                    }
                                    return potentialTrip;
                                });
                            }
                            if (potentialTripData[0].mutual) {
                                const updatedPotentialTripPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === tripId) {
                                        return {
                                            ...potentialTrip,
                                            proper_match: false,
                                            pickup_radius: newTripData.pickup_radius,
                                            destination_radius: newTripData.destination_radius,
                                            reserving_trip_obstruction: reserved === false ? false : true,
                                        };
                                    }
                                    return potentialTrip;
                                });

                                await potentialTripData[1].update({
                                    potential_trips: updatedPotentialTripPotentialTrips,
                                });
                            } else {
                                await removeMatchedTripAndUpdatePotentialTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
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
                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                        return {
                                            ...potentialTrip,
                                            mutual: true,
                                        };
                                    }
                                    return potentialTrip;
                                });
                            }
                        } else {
                            if (newlyReservedTripId === potentialTripData[0].trip_id) {
                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                        return {
                                            ...potentialTrip,
                                            reserving_trip_obstruction: true,
                                        };
                                    }
                                    return potentialTrip;
                                });
                            } else {
                                const potentialTripReservingTrip = potentialTripData[0].reserved ? await getOldTripData(potentialTripData[0].reserving_trip_id, potentialTripData[0].reserving_trip_user_id) : null;

                                const pickupDistance = potentialTripData[0].reserved ? (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === potentialTripReservingTrip[0].trip_id).pickup_distance : null;
                                const destinationDistance = potentialTripData[0].trip_id ? (editedMatchedTrips || editedPotentialTrips).find((trip) => trip.trip_id === potentialTripReservingTrip[0].trip_id).destination_distance : null;

                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                        return {
                                            ...potentialTrip,
                                            reserving_trip_obstruction: ((potentialTripData[0].reserved && isProperMatch(potentialTripReservingTrip[0], newTripData, pickupDistance, destinationDistance)) || !potentialTripData[0].reserved) ? false : true,
                                        };
                                    }
                                    return potentialTrip;
                                });
                            }

                            const updatedPotentialTripPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                if (potentialTrip.trip_id === tripId) {
                                    return {
                                        ...potentialTrip,
                                        reserving_trip_obstruction: reserved === false ? false : true,
                                    };
                                }
                                return potentialTrip;
                            });

                            await potentialTripData[1].update({
                                potential_trips: updatedPotentialTripPotentialTrips,
                            });
                        }
                    } else {
                        if (potentialTripData[0].trip_id !== newlyReservedTripId) {
                            if (potentialTripData[0].reserved || !potentialTripData[0].reserved) {
                                const reservingTrip = potentialTripData[0].reserved ? await getOldTripData(potentialTripData[0].reserving_trip_id, potentialTripData[0].reserving_trip_user_id) : null;
                                const pickupDistance = potentialTripData[0].reserved ? (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).pickup_distance : null;
                                const destinationDistance = potentialTripData[0].reserved ? (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === reservingTrip[0].trip_id).destination_distance : null;
                                if (isProperMatchDefunct(reservingTrip[0], newTripData, pickupDistance, destinationDistance) || !reservingTrip[0].reserved) {
                                    matched = true;
                                    if (!potentialTripData[0].mutual) {
                                        const [updatedPotentialTrips, updatedMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTripData[0], {
                                            paid: false,
                                            trip_group_id: null,
                                            mutual: true,
                                            reserving: false,
                                        });
                                        const editedMatchedTrips = updatedMatchedTrips;
                                        const editedPotentialTrips = updatedPotentialTrips;

                                        const updatedPotentialTripPotentialTrips = potentialTripData[0].matched_trips.map((potentialTrip) => {
                                            if (potentialTrip.trip_id === tripId) {
                                                return {
                                                    ...potentialTrip,
                                                    mutual: true,
                                                    pickup_radius: newTripData.pickup_radius,
                                                    destination_radius: newTripData.pickup_radius,
                                                };
                                            }
                                            return potentialTrip; // check as well
                                        });

                                        await potentialTripData[1].update({
                                            potential_trips: updatedPotentialTripPotentialTrips,
                                        });
                                    } else {
                                        if (reserved === true) {
                                            if (potentialTripData[0].potential_trips.find((trip) => {
                                                trip.trip_id === tripId && trip.reserving_trip_obstruction === true;
                                            })) {
                                                const updatedPotentialTripPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                                    if (potentialTrip.trip_id === tripId) {
                                                        return {
                                                            ...potentialTrip,
                                                            proper_match: true,
                                                            pickup_radius: newTripData.pickup_radius,
                                                            destination_radius: newTripData.pickup_radius,
                                                            mutual: false,
                                                        };
                                                    }
                                                    return potentialTrip; // check as well
                                                });
                                                await potentialTripData[1].update({
                                                    potential_trips: updatedPotentialTripPotentialTrips,
                                                });

                                                const [updatedPotentialTrips, updatedMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTripData[0], {
                                                    paid: false,
                                                    trip_group_id: null,
                                                    mutual: false,
                                                    reserving: false,
                                                });
                                                const editedMatchedTrips = updatedMatchedTrips;
                                                const editedPotentialTrips = updatedPotentialTrips;
                                            } else {
                                                const [updatedPotentialTripPotentialTrips, updatedPotentialTripMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                                    paid: false,
                                                    trip_group_id: null,
                                                    mutual: true,
                                                    reserving: false,
                                                    status: "matched",
                                                });

                                                potentialTripData[1].update({
                                                    matched_trips: updatedPotentialTripMatchedTrips,
                                                    potential_trips: updatedPotentialTripPotentialTrips,
                                                });

                                                const [updatedPotentialTrips, updatedMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTripData[0], {
                                                    paid: false,
                                                    trip_group_id: null,
                                                    mutual: true,
                                                    reserving: false,
                                                });
                                                const editedMatchedTrips = updatedMatchedTrips;
                                                const editedPotentialTrips = updatedPotentialTrips;
                                            }
                                        } else {
                                            const updatedPotentialTripPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                                if (potentialTrip.trip_id === tripId) {
                                                    return {
                                                        ...potentialTrip,
                                                        proper_match: true,
                                                        pickup_radius: newTripData.pickup_radius,
                                                        destination_radius: newTripData.pickup_radius,
                                                        mutual: false,
                                                    };
                                                }
                                                return potentialTrip; // check as well
                                            });
                                            await potentialTripData[1].update({
                                                potential_trips: updatedPotentialTripPotentialTrips,
                                            });

                                            const [updatedPotentialTrips, updatedMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTripData[0], {
                                                paid: false,
                                                trip_group_id: null,
                                                mutual: false,
                                                reserving: false,
                                            });
                                            const editedMatchedTrips = updatedMatchedTrips;
                                            const editedPotentialTrips = updatedPotentialTrips;
                                        }
                                    }
                                }
                                } else {
                                    if (!potentialTripData[0].mutual) {
                                        const updatedPotentialTripPotentialTrips = potentialTripData[0].matched_trips.map((potentialTrip) => {
                                            if (potentialTrip.trip_id === tripId) {
                                                return {
                                                    ...potentialTrip,
                                                    pickup_radius: newTripData.pickup_radius,
                                                    destination_radius: newTripData.pickup_radius,
                                                };
                                            }
                                            return potentialTrip; // check as well
                                        });

                                        await potentialTripData[1].update({
                                            potential_trips: updatedPotentialTripPotentialTrips,
                                        });
                                    } else {
                                        if (reserved === true) {
                                            if (potentialTripData[0].potential_trips.find((trip) => {
                                                trip.trip_id === tripId && trip.reserving_trip_obstruction === true;
                                            })) {
                                                const updatedPotentialTripPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                                    if (potentialTrip.trip_id === tripId) {
                                                        return {
                                                            ...potentialTrip,
                                                            proper_match: true,
                                                            pickup_radius: newTripData.pickup_radius,
                                                            destination_radius: newTripData.pickup_radius,
                                                        };
                                                    }
                                                    return potentialTrip; // check as well
                                                });
                                                await potentialTripData[1].update({
                                                    potential_trips: updatedPotentialTripPotentialTrips,
                                                });

                                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                                        return {
                                                            ...potentialTrip,
                                                            proper_match: true,
                                                            reserving_trip_obstruction: true,
                                                        };
                                                    }
                                                    return potentialTrip;
                                                });
                                            } else {
                                                const [updatedPotentialTripPotentialTrips, updatedPotentialTripMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                                    paid: false,
                                                    trip_group_id: null,
                                                    mutual: false,
                                                    reserving: false,
                                                    status: "matched",
                                                });

                                                potentialTripData[1].update({
                                                    matched_trips: updatedPotentialTripMatchedTrips,
                                                    potential_trips: updatedPotentialTripPotentialTrips,
                                                });

                                                editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                                    if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                                        return {
                                                            ...potentialTrip,
                                                            proper_match: true,
                                                            mutual: false,
                                                            reserving_trip_obstruction: true,
                                                        };
                                                    }
                                                    return potentialTrip;
                                                });
                                            }
                                        } else {
                                            const [updatedPotentialTripPotentialTrips, updatedPotentialTripMatchedTrips] = await removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                                paid: false,
                                                trip_group_id: null,
                                                mutual: false,
                                                reserving: false,
                                                status: "matched",
                                            });

                                            potentialTripData[1].update({
                                                matched_trips: updatedPotentialTripMatchedTrips,
                                                potential_trips: updatedPotentialTripPotentialTrips,
                                            });

                                            editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                                if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                                    return {
                                                        ...potentialTrip,
                                                        proper_match: true,
                                                        mutual: false,
                                                        reserving_trip_obstruction: true,
                                                    };
                                                }
                                                return potentialTrip;
                                            });
                                        }
                                    }
                                }
                         } else {
                            await removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                paid: false,
                                trip_group_id: null,
                                mutual: false,
                                reserving: false,
                                status: "matched",
                            });

                            editedPotentialTrips = editedPotentialTrips.map((potentialTrip) => {
                                if (potentialTrip.trip_id === potentialTripData[0].trip_id) {
                                    return {
                                        ...potentialTrip,
                                        proper_match: true,
                                        mutual: false,
                                        reserving_trip_obstruction: true,
                                    };
                                }
                                return potentialTrip;
                            });
                         }
                    }
                }
            }
            const editedTripPaidMatchedPotential = editedPotentialTrips.filter(
                (potentialTrip) => potentialTrip.paid,
            ).concat(
                editedMatchedTrips.filter((matchedTrip) => matchedTrip.paid),
            );

            if (editedTripPaidMatchedPotential) {
                const tripGroups = await getDistinctPaidTripGroups(editedTripPaidMatchedPotential);
                distinctTripGroups.push(tripGroups);

                for (const tripGroup of distinctTripGroups) {
                    tripGroupsInfo.push({
                        tripGroupId: tripGroup.trip_group_id,
                        tripObstruction: false,
                        seatObstruction: false,
                        largestPickupOverlapGap: calculateOverlapGap(tripGroup)[0],
                        largestDestinationOverlapGap: calculateOverlapGap(tripGroup)[1],
                    });
                }

                for (const tripGroup of distinctTripGroups) {
                    let obstructingTripMembers = [];
                    const tripGroupDocRef = db.collection("trip_groups").doc(tripGroup.trip_group_id);
                    const groupMembers = tripGroup.trip_group_members;
                    let groupInfo = tripGroupsInfo.find((info) => info.tripGroupId === tripGroup.trip_group_id);
                    for (const member of groupMembers) {
                        const editedTripInTripGroup = tripGroup.potential_trip_members.find((trip) => trip.trip_id === tripId);
                        if (editedTripInTripGroup.obstructing_trip_members.some((trip) => trip.trip_id === member.trip_id && trip.unknown)) {
                            tripGroupsInfo = tripGroupsInfo.map((group) => {
                                if (group.tripGroupId === tripGroup.trip_group_id) {
                                    return {
                                        ...group,
                                        tripObstruction: true,
                                    };
                                }
                                return group;
                            });
                        } else {
                            const memberData = await getOldTripData(member.trip_id, member.user_id);
                            const pickupDistance = (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === member.trip_id).pickup_distance;
                            const destinationDistance = (editedPotentialTrips || editedMatchedTrips).find((trip) => trip.trip_id === member.trip_id).destination_distance;
                            if (!isProperMatchDefunct(memberData[0], newTripData, pickupDistance, destinationDistance)) {
                                tripGroupsInfo = tripGroupsInfo.map((group) => {
                                    if (group.tripGroupId === tripGroup.trip_group_id) {
                                        return {
                                            ...group,
                                            tripObstruction: true,
                                        };
                                    }
                                    return group;
                                });
                                const pickupOverlapGap = await calculatePickupOverlapGapWithET(memberData[0], newTripData);
                                const destinationOverlapGap = await calculateDestinationOverlapGapWithET(memberData[0], newTripData);
                                if (editedTripInTripGroup.obstructing_trip_members.some(async (trip) => trip.trip_id === member.trip_id && pickupOverlapGap > groupInfo.largestPickupOverlapGap)) {
                                    tripGroupsInfo = tripGroupsInfo.map(async (group) => {
                                        if (group.tripGroupId === tripGroup.trip_group_id) {
                                            return {
                                                ...group,
                                                largestPickupOverlapGap: pickupOverlapGap,
                                            };
                                        }
                                        return group;
                                    });
                                } else if (editedTripInTripGroup.obstructing_trip_members.some(async (trip) => trip.trip_id === member.trip_id && destinationOverlapGap > groupInfo.largestDestinationOverlapGap)) {
                                    tripGroupsInfo = tripGroupsInfo.map(async (group) => {
                                        if (group.tripGroupId === tripGroup.trip_group_id) {
                                            return {
                                                ...group,
                                                largestDestinationOverlapGap: destinationOverlapGap,
                                            };
                                        }
                                        return group;
                                    });
                                }
                                if (editedTripInTripGroup.obstructing_trip_members.some((trip) => trip.trip_id === member.trip_id)) {
                                    obstructingTripMembers = editedTripInTripGroup.obstructing_trip_members.map((trip) => {
                                        if (trip.trip_id === member.trip_id) {
                                            return {
                                                ...trip,
                                                pickup_overlap_gap: pickupOverlapGap,
                                                destination_overlap_gap: destinationOverlapGap,
                                            };
                                        }
                                        return trip;
                                    });
                                } else {
                                    obstructingTripMembers = editedTripInTripGroup.obstructing_trip_members.map((trip) => {
                                        if (trip.trip_id === member.trip_id) {
                                            return trip;
                                        }
                                    });
                                    obstructingTripMembers.push({
                                        trip_id: member.trip_id,
                                        pickup_overlap_gap: pickupOverlapGap,
                                        destination_overlap_gap: destinationOverlapGap,
                                    });
                                }
                            } else {
                                if (editedTripInTripGroup.obstructing_trip_members.some((trip) => trip.trip_id === member.trip_id)) {
                                    obstructingTripMembers = editedTripInTripGroup.obstructing_trip_members.filter((trip) => trip.trip_id === member.trip_id);
                                }
                            }
                        }
                    }
                    groupInfo = tripGroupsInfo.find((info) => info.tripGroupId === tripGroup.trip_group_id);
                    await tripGroupDocRef.update({
                        potential_trip_members: tripGroup.potential_trip_members.map((trip) => {
                            if (trip.trip_id === tripId) {
                                return {
                                    ...trip,
                                    obstructing_trip_members: obstructingTripMembers,
                                    trip_obstruction: groupInfo.tripObstruction,
                                };
                            }
                            return trip;
                        }),
                    });
                }
            }
        }
        const editedTripPaidMatchedPotential = editedPotentialTrips.filter(
            (potentialTrip) => potentialTrip.paid,
        ).concat(
            editedMatchedTrips.filter((matchedTrip) => matchedTrip.paid),
        );

        if (editedTripPaidMatchedPotential) {
            if (!distinctTripGroups) {
                const tripGroups = await getDistinctPaidTripGroups(editedTripPaidMatchedPotential);
                distinctTripGroups.push(tripGroups);
            }

            if (!tripGroupsInfo) {
                for (const tripGroup of distinctTripGroups) {
                    tripGroupsInfo.push({
                        tripGroupId: tripGroup.trip_group_id,
                        tripObstruction: false,
                        seatObstruction: false,
                        largestPickupOverlapGap: calculateOverlapGap(tripGroup)[0],
                        largestDestinationOverlapGap: calculateOverlapGap(tripGroup)[1],
                    });
                }
            }
            for (const tripGroup of distinctTripGroups) {
                const tripGroupDocRef = db.collection("trip_groups").doc(tripGroup.trip_group_id);
                tripGroupsInfo = tripGroupsInfo.map((group) => {
                    if (group.tripGroupId === tripGroup.trip_group_id) {
                        return {
                            ...group,
                            seatObstruction: (4 - tripGroup.total_seat_count) >= newTripData.seat_count ? false : true,
                        };
                    }
                    return group;
                });
                const groupInfo = tripGroupsInfo.find((info) => info.tripGroupId === tripGroup.trip_group_id);
                await tripGroupDocRef.update({
                    potential_trip_members: tripGroup.potential_trip_members.map((trip) => {
                        if (trip.trip_id === tripId) {
                            return {
                                ...trip,
                                seat_obstruction: groupInfo.seatObstruction,
                            };
                        }
                        return trip;
                    }),
                });
            }

            const editedTripPaidMatchedTrips = editedMatchedTrips.filter(
                (matchedTrip) => matchedTrip.paid,
            );

            if (editedTripPaidMatchedTrips) {
                for (const matchedTrip of editedTripPaidMatchedTrips) {
                    const matchedTripData = await getOldTripData(matchedTrip.trip_id, matchedTrip.user_id);
                    const groupInfo = tripGroupsInfo.find((info) => info.tripGroupId === matchedTripData[0].trip_group_id);
                    const groupData = distinctTripGroups.find((group) => group.trip_group_id === matchedTripData[0].trip_group_id);
                    const pickupDistance = editedMatchedTrips.find((trip) => trip.trip_id === matchedTripData[0].trip_id).pickup_distance; // check this (needs to be just matchedtrip)
                    const destinationDistance = editedMatchedTrips.find((trip) => trip.trip_id === matchedTripData[0].trip_id).destination_distance;
                    if (isProperMatchDefunct(matchedTripData[0], newTripData, pickupDistance, destinationDistance)) {
                        if (groupInfo.tripObstruction === true || groupInfo.seatObstruction === true) {
                            let mutual;
                            if (matchedTrip.mutual || (!matchedTrip.mutual && reserved === false)) {
                                mutual = false;
                            } else if (!matchedTrip.mutual && reserved === true) {
                                mutual = true;
                            }
                            const [updatedEditedTripPotentialTrips, updatedEditedTripMatchedTrips] = await removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                                paid: true,
                                trip_group_id: matchedTripData[0].trip_group_id,
                                proper_match: true,
                                trip_obstruction: groupInfo.trip_obstruction,
                                seat_obstruction: groupInfo.seat_obstruction,
                                reserving_trip_obstruction: false,
                                mutual: mutual,
                                group_largest_pickup_overlap_gap: groupInfo.largestPickupOverlapGap > 0 ? groupInfo.largestPickupOverlapGap : null,
                                group_largest_destination_overlap_gap: groupInfo.largestDestinationOverlapGap > 0 ? groupInfo.largestDestinationOverlapGap : null,
                                unknown_trip_obstruction: false,
                                total_seat_count: groupData.totalSeatCount, // check
                            }); // check after removing any matched trip check if it still has matched trips

                            editedMatchedTrips = updatedEditedTripMatchedTrips;
                            editedPotentialTrips = updatedEditedTripPotentialTrips;
                        } else {
                            matched = true;
                            let mutual;
                            if (matchedTrip.mutual || (!matchedTrip.mutual && reserved === false)) {
                                mutual = true;
                            } else if (!matchedTrip.mutual && reserved === true) {
                                mutual = false;
                            }
                            editedMatchedTrips = editedMatchedTrips.map((mt) => {
                                if (mt.trip_id === matchedTrip.trip_id) {
                                    return {
                                        ...mt,
                                        mutual: mutual,
                                    };
                                }
                                return mt;
                            });
                        }

                        if (matchedTrip.mutual) {
                            const updatedMatchedTrips = matchedTripData[0].matched_trips.map((mt) => {
                                if (mt.trip_id === tripId) {
                                    return {
                                        ...mt,
                                        pickup_radius: newTripData.pickup_radius,
                                        destination_radius: newTripData.destination_radius,
                                        mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? false : true,
                                    };
                                }
                                return mt;
                            });
                            await matchedTripData[1].update({
                                matched_trips: updatedMatchedTrips,
                            });
                        } else {
                            if (reserved === true) {
                                const updatedPotentialTrips = matchedTripData[0].potential_trips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === tripId) {
                                        return {
                                            ...potentialTrip,
                                            pickup_radius: newTripData.pickup_radius,
                                            destination_radius: newTripData.destination_radius,
                                            mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? true : false,
                                        };
                                    }
                                    return potentialTrip;
                                });
                                await matchedTripData[1].update({
                                    potential_trips: updatedPotentialTrips,
                                });
                            } else {
                                removePotentialTripAndUpdateMatchedTrips(matchedTripData[0].matched_trips, matchedTripData[0].potential_trips, newTripData, {
                                    paid: false,
                                    trip_group_id: "",
                                    mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? false : true,
                                    reserving: false,
                                });
                            }
                        }
                    } else {
                        removeMatchedTripAndUpdatePotentialTrips(editedMatchedTrips, editedPotentialTrips, matchedTrip, {
                            paid: true,
                            trip_group_id: matchedTripData[0].trip_group_id,
                            proper_match: false,
                            trip_obstruction: true,
                            seat_obstruction: groupInfo.seat_obstruction,
                            reserving_trip_obstruction: false,
                            mutual: true,
                            group_largest_pickup_overlap_gap: groupInfo.largestPickupOverlapGap > 0 ? groupInfo.largestPickupOverlapGap : null,
                            group_largest_destination_overlap_gap: groupInfo.largestDestinationOverlapGap > 0 ? groupInfo.largestDestinationOverlapGap : null,
                            unknown_trip_obstruction: false,
                            total_seat_count: groupData.totalSeatCount, // check
                        });

                        if (matchedTrip.mutual) {
                            removeMatchedTripAndUpdatePotentialTrips(matchedTripData[0].matched_trips, matchedTripData[0].potential_trips, newTripData, {
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
                        } else {
                            const updatedPotentialTrips = matchedTripData[0].potential_trips.map((potentialTrip) => {
                                if (potentialTrip.trip_id === tripId) {
                                    return {
                                        ...potentialTrip,
                                        pickup_radius: newTripData.pickup_radius,
                                        destination_radius: newTripData.destination_radius,
                                        mutual: true,
                                        reserving_trip_obstruction: reserved === false ? false : potentialTrip.reserving_trip_obstruction,
                                    };
                                }
                                return potentialTrip;
                            });
                            await matchedTripData[1].update({
                                potential_trips: updatedPotentialTrips,
                            });
                        }
                    }
                }
            }

            const editedTripPaidPotentialTrips = editedPotentialTrips.filter(
                (potentialTrip) => potentialTrip.paid,
            );

            if (editedTripPaidPotentialTrips) {
                for (const potentialTrip of editedTripPaidMatchedTrips) {
                    const potentialTripData = await getOldTripData(potentialTrip.trip_id, potentialTrip.user_id);
                    const groupInfo = tripGroupsInfo.find((info) => info.tripGroupId === potentialTripData[0].trip_group_id);
                    const pickupDistance = editedPotentialTrips.find((trip) => trip.trip_id === potentialTripData[0].trip_id).pickup_distance; // check this (needs to be just potentialTrip)
                    const destinationDistance = editedPotentialTrips.find((trip) => trip.trip_id === potentialTripData[0].trip_id).destination_distance;
                    if (newTripData.pickup_radius !== previousData.pickup_radius || newTripData.destination_radius !== previousData.destination_radius) {
                        if (isProperMatchDefunct(potentialTrip, newTripData, pickupDistance, destinationDistance)) {
                            if (groupInfo.tripObstruction === true || groupInfo.seatObstruction === true) {
                                let mutual;
                                if (!potentialTrip.mutual || (potentialTrip.mutual && reserved === false)) {
                                    mutual = false;
                                } else if (potentialTrip.mutual && reserved === true) {
                                    mutual = potentialTripData[0].potential_trips.find((pt) => pt.trip_id === tripId).reserving_trip_obstruction === true ? true : false;
                                }
                                editedPotentialTrips = editedPotentialTrips.map((pt) => {
                                    if (pt.trip_id === potentialTrip.trip_id) {
                                        return {
                                            ...pt,
                                            proper_match: true,
                                            trip_obstruction: groupInfo.tripObstruction,
                                            seat_obstruction: groupInfo.seatObstruction,
                                            mutual: mutual,
                                            group_largest_pickup_overlap_gap: groupInfo.largestPickupOverlapGap > 0 ? groupInfo.largestPickupOverlapGap : null,
                                            group_largest_destination_overlap_gap: groupInfo.largestDestinationOverlapGap > 0 ? groupInfo.largestDestinationOverlapGap : null,
                                        };
                                    }
                                    return pt;
                                });
                            } else {
                                matched = true;
                                let mutual;
                                if (!potentialTrip.mutual || (potentialTrip.mutual && reserved === false)) {
                                    mutual = true;
                                } else if (potentialTrip.mutual && reserved === true) {
                                    mutual = potentialTripData[0].potential_trips.find((pt) => pt.trip_id === tripId).reserving_trip_obstruction === true ? false : true;
                                }
                                removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTrip, {
                                    paid: true,
                                    trip_group_id: potentialTrip.trip_group_id,
                                    reserving: false,
                                    mutual: mutual,
                                });
                            }

                            if (!potentialTrip.mutual) {
                                const updatedMatchedTrips = potentialTripData[0].matched_trips.map((mt) => {
                                    if (mt.trip_id === tripId) {
                                        return {
                                            ...mt,
                                            pickup_radius: newTripData.pickup_radius,
                                            destination_radius: newTripData.destination_radius,
                                            mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? false : true,
                                        };
                                    }
                                    return mt;
                                });
                                await potentialTripData[1].update({
                                    matched_trips: updatedMatchedTrips,
                                });
                            } else {
                                if (reserved === true) {
                                    if (potentialTripData[0].potential_trips.find((pt) => pt.trip_id === tripId).reserving_trip_obstruction === true) {
                                        const updatedPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                            if (potentialTrip.trip_id === tripId) {
                                                return {
                                                    ...potentialTrip,
                                                    pickup_radius: newTripData.pickup_radius,
                                                    destination_radius: newTripData.destination_radius,
                                                    mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? true : false,
                                                };
                                            }
                                            return potentialTrip;
                                        });
                                        await potentialTripData[1].update({
                                            potential_trips: updatedPotentialTrips,
                                        });
                                    } else {
                                        removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                            paid: false,
                                            trip_group_id: "",
                                            mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? false : true,
                                            reserving: false,
                                        }); // check why doesnt all the other mutual check have a check for reserving_trip_obstruction
                                    }
                                } else {
                                    removePotentialTripAndUpdateMatchedTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
                                        paid: false,
                                        trip_group_id: "",
                                        mutual: groupInfo.tripObstruction === true || groupInfo.seatObstruction === true ? false : true,
                                        reserving: false,
                                    });
                                }
                            }
                        } else {
                            editedPotentialTrips = editedPotentialTrips.map((pt) => {
                                if (pt.trip_id === potentialTrip.trip_id) {
                                    return {
                                        ...pt,
                                        proper_match: false,
                                        trip_obstruction: groupInfo.tripObstruction,
                                        seat_obstruction: groupInfo.seatObstruction,
                                        mutual: true,
                                        group_largest_pickup_overlap_gap: groupInfo.largestPickupOverlapGap > 0 ? groupInfo.largestPickupOverlapGap : null,
                                        group_largest_destination_overlap_gap: groupInfo.largestDestinationOverlapGap > 0 ? groupInfo.largestDestinationOverlapGap : null,
                                    };
                                }
                                return pt;
                            });

                            if (!potentialTrip.mutual) {
                                removeMatchedTripAndUpdatePotentialTrips(potentialTripData[0].matched_trips, potentialTripData[0].potential_trips, newTripData, {
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
                            } else {
                                const updatedPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === tripId) {
                                        return {
                                            ...potentialTrip,
                                            pickup_radius: newTripData.pickup_radius,
                                            destination_radius: newTripData.destination_radius,
                                            mutual: true,
                                            reserving_trip_obstruction: reserved === false ? false : potentialTrip.reserving_trip_obstruction,
                                        };
                                    }
                                    return potentialTrip;
                                });
                                await potentialTripData[1].update({
                                    potential_trips: updatedPotentialTrips,
                                });
                            }
                        }
                    } else {
                        if (groupInfo.seatObstruction) {
                            editedPotentialTrips = editedPotentialTrips.map((pt) => {
                                if (pt.trip_id === potentialTrip.trip_id) {
                                    return {
                                        ...pt,
                                        seat_obstruction: true,
                                    };
                                }
                                return pt;
                            });
                        } else if (!potentialTrip.trip_obstruction) {
                            matched = true;
                            const [updatedMatchedTrips, updatedPotentialTrips] = await removePotentialTripAndUpdateMatchedTrips(editedMatchedTrips, editedPotentialTrips, potentialTrip, {
                                paid: true,
                                trip_group_id: potentialTrip.trip_group_id,
                                mutual: potentialTrip.mutual ? false : true,
                                reserving: false,
                            });
                            editedMatchedTrips = updatedMatchedTrips;
                            editedPotentialTrips= updatedPotentialTrips;
                            if (potentialTrip.mutual) {
                                const updatedPotentialTrips = potentialTripData[0].potential_trips.map((potentialTrip) => {
                                    if (potentialTrip.trip_id === tripId) {
                                        return {
                                            ...potentialTrip,
                                            mutual: false,
                                        };
                                    }
                                    return potentialTrip;
                                });
                                await potentialTripData[1].update({
                                    potential_trips: updatedPotentialTrips,
                                });
                            } else {
                                const updatedPotentialTrips = potentialTripData[0].matched_trips.map((mt) => {
                                    if (mt.trip_id === tripId) {
                                        return {
                                            ...mt,
                                            mutual: true,
                                        };
                                    }
                                    return mt;
                                });
                                await potentialTripData[1].update({
                                    matched_trips: updatedPotentialTrips,
                                });
                            }
                        }
                    }
                }
            }
        }
        await snapshot.after.ref.update({
            matched_trips: editedMatchedTrips,
            potential_trips: editedPotentialTrips,
            matched: matched === true ? "matched" : "unmatched",
        });
        return null;
      } catch (error) {
        console.error("Error in tripCanceledFunction:", error);
        throw error;
      }
    });
