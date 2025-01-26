/* eslint-disable linebreak-style */
/* eslint-disable no-unused-vars */
/* eslint-disable arrow-parens */
/* eslint-disable max-len */
/* eslint-disable indent */
/* eslint-disable no-constant-condition */
/* eslint-disable camelcase */

/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const axios = require("axios");


// The Firebase Admin SDK to access Firestore.
const {db, arrayUnion, del} = require("./firebaseAdmin");
const {user} = require("firebase-functions/v1/auth");


exports.tripPaidFunction = onDocumentUpdated("users/{userId}/trips/{tripId}",
    async (event) => {
      try {
        const userId = event.params.userId;
        const tripId = event.params.tripId;
        const newTripDocRef = db.collection(`users/${userId}/trips`).doc(tripId);
        const snapshot = event.data;
        if (!snapshot) {
          console.log("No data associated with the event");
          return;
        }
        const newTripData = snapshot.after.data();
        const previousData = event.data.before.data();
        let choiceTripGroup;

        if (newTripData.paid === previousData.paid || newTripData.paid===false) {
            return null;
        }

        const getTripMatchedTrips = async () => {
            const tripDoc = await newTripDocRef.get();
            const tripData = tripDoc.docs.data();
            return tripData.matched_trips;
        };

        const calculatePickupOverlapGapWithNpt = async (trip, npt) => {
            let tripData = trip;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            const pickupDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === npt.trip_id,
              ).pickup_distance;
            const pickupOverlapGap = 150 - (tripData.pickup_radius + npt.pickup_radius - pickupDistance);
            return pickupOverlapGap >= 0 ? pickupOverlapGap : null;
        };

        const calculateDestinationOverlapGapWithNpt = async (trip, npt) => {
            let tripData = trip;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            const destinationDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === npt.trip_id,
              ).destination_distance;
            const destinationOverlapGap = 150 - (tripData.destination_radius + npt.destination_radius - destinationDistance);
            return destinationOverlapGap >= 0 ? destinationOverlapGap : null;
        };

        const calculatePickupOverlapGap = async (trip, trip2) => {
            let tripData = trip;
            let trip2Data = trip2;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            if (!trip2.matched_trips) {
                const trip2Doc = await db.collection(`users/${trip2.user_id}/trips`).doc(trip2.trip_id).get();
                trip2Data = trip2Doc.data();
            }
            const pickupDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === trip2.trip_id,
              ).pickup_distance;
            const pickupOverlapGap = 150 - (tripData.pickup_radius + trip2Data.pickup_radius - pickupDistance);
            return pickupOverlapGap >= 0 ? pickupOverlapGap : null;
        };

        const calculateDestinationOverlapGap = async (trip, trip2) => {
            let tripData = trip;
            let trip2Data = trip2;
            if (!trip.matched_trips) {
                const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                tripData = tripDoc.data();
            }
            if (!trip2.matched_trips) {
                const trip2Doc = await db.collection(`users/${trip2.user_id}/trips`).doc(trip2.trip_id).get();
                trip2Data = trip2Doc.data();
            }
            const destinationDistance = (tripData.potential_trips || tripData.matched_trips).find(
                (trip) => trip.trip_id === trip2.trip_id,
              ).destination_distance;
            const destinationOverlapGap = 150 - (tripData.destination_radius + trip2Data.destination_radius - destinationDistance);
            return destinationOverlapGap >= 0 ? destinationOverlapGap : null;
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

        const isProperMatchDefunct = (potentialTrip, newTripData, pickupDistance, destinationDistance) => {
            const isPickupWithinRadius = pickupDistance <= newTripData.pickup_radius && pickupDistance <= potentialTrip.pickup_radius;
            const isDestinationWithinRadius = destinationDistance <= newTripData.destination_radius && destinationDistance <= potentialTrip.destination_radius;
            return isPickupWithinRadius && isDestinationWithinRadius;
        };

        const isProperMatch = (trip1Data, trip2) => {
            const isPotentialAndProperMatch = trip1Data.potential_trips.some(potentialTrip => potentialTrip.trip_id === trip2.trip_id && potentialTrip.proper_match === true);

            const isMatched = trip1Data.matched_trips.some(potentialTrip => potentialTrip.trip_id === trip2.trip_id);

            return (isPotentialAndProperMatch || isMatched);
        };

        const isProperMatchWithTripGroupMembers = (oldTripGroupData, tripData) => {
            const groupMembers = oldTripGroupData.trip_group_members.map((member) => ({trip_id: member.trip_id, user_id: member.user_id}));

            if (groupMembers.every(async (member) => {
                const tripDoc = await db
                .collection(`users/${member.user_id}/trips`)
                .doc(member.trip_id).get();
                const trip = tripDoc.data();
                isProperMatch(tripData, trip);
            })) {
                return true;
            } else {
                return false;
            }
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

        const getOldTripGroupData = async (tripGroupID) => {
            const tripGroupDocRef = db.collection("trip_groups").doc(tripGroupID);
            const tripGroupDoc = await tripGroupDocRef.get();

            if (!tripGroupDoc.exists) {
                console.log(`Trip group with ID ${tripGroupID} does not exist.`);
                return;
            }

            return tripGroupDoc.data();
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

        const getDistinctPaidTripGroups = async () => {
            // const matched_trips = await getTripMatchedTrips();
            const matched_trips = newTripData.matched_trips;

            const paidTrips = matched_trips.filter((trip) => trip.paid);

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

        const getChoiceTripGroup = async () => {
            const distinctTripGroups = await getDistinctPaidTripGroups();

            if (distinctTripGroups.length === 0) {
                console.log("No distinct trip groups found.");
                return null;
            }

            if (distinctTripGroups.length === 1) {
                return distinctTripGroups[0];
            }

            let minTripCount = Infinity;
            let leastTripGroups = [];

            for (const tripGroup of distinctTripGroups) {
                const tripCount = tripGroup.trip_group_members.length;

                if (tripCount < minTripCount) {
                    minTripCount = tripCount;
                    leastTripGroups = [tripGroup];
                } else if (tripCount === minTripCount) {
                    leastTripGroups.push(tripGroup);
                }
            }

            if (leastTripGroups.length === 1) {
                return leastTripGroups[0];
            }

            let minTotalDistance = Infinity;
            let closestTripGroups = [];

            for (const tripGroup of leastTripGroups) {
                const totalPickupDistance = tripGroup.trip_group_members.reduce((total, member) => {
                    const matchedTrip = newTripData.matched_trips.find(trip => trip.trip_id === member.trip_id);
                    return total + (matchedTrip ? matchedTrip.pickup_distance : 0);
                }, 0);

                const totalDestinationDistance = tripGroup.trip_group_members.reduce((total, member) => {
                    const matchedTrip = newTripData.matched_trips.find(trip => trip.trip_id === member.trip_id);
                    return total + (matchedTrip ? matchedTrip.destination_distance : 0);
                }, 0);

                const totalDistance = totalPickupDistance + totalDestinationDistance;

                if (totalDistance < minTotalDistance) {
                    minTotalDistance = totalDistance;
                    closestTripGroups = [tripGroup];
                } else if (totalDistance === minTotalDistance) {
                    closestTripGroups.push(tripGroup);
                }
            }

            if (closestTripGroups.length === 1) {
                return closestTripGroups[0];
            }

            const randomIndex = Math.floor(Math.random() * closestTripGroups.length);
            return closestTripGroups[randomIndex];
        };

        const getTripsThatHaveReservedTripInPotentialTrips = (trip) => {
            const potentialTrips = trip.potential_trips;
            const matchedTrips = trip.matched_trips;

            const matchingTripsWithFalseMutual = matchedTrips.filter((matchedTrip) => {
                return matchedTrip.mutual === false;
            });

            const potentialTripsWithTrueMutual = potentialTrips.filter((potentialTrip) => {
                return potentialTrip.mutual === true;
            });

            return [
                ...matchingTripsWithFalseMutual,
                ...potentialTripsWithTrueMutual,
            ];
        };


        const updateSoleTripGroupMember = async (soleMember) => {
            const soleMemberDocRef = db.collection(`users/${soleMember.user_id}/trips`).doc(soleMember.trip_id);
            const soleMemberDoc = await soleMemberDocRef.get();
            const soleMemberData = soleMemberDoc.data();

            const reservedTripinMatchedTrips = soleMemberData.matched_trips.find(trip => trip.reserving === true);

            if (!reservedTripinMatchedTrips) {
                console.log("No reserving trip found for sole trip group member.");
                return;
            }

            await soleMemberDocRef.update({
                "matched_trips": soleMemberData.matched_trips.map(trip => {
                    if (trip.trip_id === reservedTripinMatchedTrips.trip_id) {
                        return {
                            ...trip,
                            reserving: false,
                        };
                    }
                    return trip;
                }),
            });

            const reservedTripDocRef = db.collection(`users/${reservedTripinMatchedTrips.user_id}/trips`).doc(reservedTripinMatchedTrips.trip_id);
            await reservedTripDocRef.update({
                reserved: false,
                reserving_trip_id: del(),
            });
            const reservedTripDoc = reservedTripDocRef.get();
            const reservedTrip = reservedTripDoc.data();
            return reservedTrip;
        };

        const updateMatchingTrips = async (reservedTrip, tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue) => {
            for (const {tripData, trip} of tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue) {
                const tripDocRef = db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id);
                // Step 1: Update potential_trips by removing the reserved trip
                const updatedPotentialTrips = tripData.potential_trips.filter(potentialTrip => potentialTrip.trip_id !== reservedTrip.trip_id);

                // Step 2: Add the reserved trip to matched_trips
                const newMatchedTrip = {
                    trip_id: reservedTrip.trip_id,
                    trip_group_id: "N/A",
                    paid: false,
                    pickup_radius: reservedTrip.pickup_radius,
                    destination_radius: reservedTrip.destination_radius,
                    pickup_distance: tripData.potential_trips.find((pt) => pt.trip_id === reservedTrip.trip_id).pickup_distance,
                    destination_distance: tripData.potential_trips.find((pt) => pt.trip_id === reservedTrip.trip_id).destination_distance,
                    mutual: reservedTrip.matched_trips.some(matchedTrip => matchedTrip.trip_id === tripData.trip_id),
                    reserving: false,
                };

                await tripDocRef.update({
                    "potential_trips": updatedPotentialTrips,
                    "matched_trips": [...tripData.matched_trips, newMatchedTrip],
                });
            }
        };

        const updateReservedTrip = async (reservedTrip, tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue) => {
            const reservedTripDocRef = db.collection(`users/${reservedTrip.user_id}/trips`).doc(reservedTrip.trip_id);
            const reservedTripDoc = await reservedTripDocRef.get();
            const reservedTripData = reservedTripDoc.data();
            // Step 1: Update matched_trips (set mutual to true)
            const updatedMatchedTrips = reservedTripData.matched_trips.map(matchedTrip => {
                if (tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue.some(trip => trip.trip_id === matchedTrip.trip_id)) {
                    return {
                        ...matchedTrip,
                        mutual: true,
                    };
                }
                return matchedTrip;
            });

            // Step 2: Update potential_trips (set mutual to false)
            const updatedPotentialTrips = reservedTripData.potential_trips.map(potentialTrip => {
                if (tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue.some(trip => trip.trip_id === potentialTrip.trip_id && potentialTrip.mutual === true)) {
                    return {
                        ...potentialTrip,
                        mutual: false,
                    };
                }
                return potentialTrip;
            });
            await reservedTripDocRef.update({
                matched_trips: updatedMatchedTrips,
                potential_trips: updatedPotentialTrips,
            });
        };

        const updateChoiceTripGroupMembers = async (choiceTripGroup, npt) => {
            const tripGroupMembers = choiceTripGroup.trip_group_members;

            for (const member of tripGroupMembers) {
                const memberTripDocRef = db.collection(`users/${member.user_id}/trips`).doc(member.trip_id);
                const memberTripDoc = await memberTripDocRef.get();
                const memberTripData = memberTripDoc.data();

                // Step 1: Update matched_trips with NPT information
                const updatedMatchedTrips = memberTripData.matched_trips.map(trip => {
                    if (trip.trip_id === npt.trip_id) {
                        return {
                            ...trip,
                            paid: true,
                            trip_group_id: choiceTripGroup.trip_group_id,
                        };
                    }
                    return trip;
                });

                await memberTripDocRef.update({
                    total_seat_count: choiceTripGroup.total_seat_count + npt.seat_count,
                    matched_trips: updatedMatchedTrips,
                });
            }
        };

        const updateChoiceTripGroupWithNPT = async (choiceTripGroupData, npt) => {
            const updatedTotalSeatCount = choiceTripGroupData.total_seat_count + npt.seat_count;

            // Step 2: Delete NPT from potential_trip_members and add to trip_group_members
            const updatedPotentialTripMembers = choiceTripGroupData.potential_trip_members.filter(member => member.trip_id !== npt.trip_id);
            const newTripGroupMember = {
                trip_id: npt.trip_id,
                first_name: npt.first_name,
                phone_number: npt.phone_number,
                photo_url: npt.photo_url,
                seat_count: npt.seat_count,
            };

            return [updatedTotalSeatCount, updatedPotentialTripMembers, newTripGroupMember];
        };

        const updateSeatObstructedTrips = async (totalSeatCount, updatedPotentialTripMembers) => {
            const obstructedTrips = updatedPotentialTripMembers.filter(member => {
                // Exclude newTripData itself
                if (member.trip_id === newTripData.trip_id) return false;

                return member.seat_obstruction === false && member.seat_count > (4 - totalSeatCount);
            });

            // Step 5: Update seat_obstruction for obstructed trips
            const updatedSeatObstructedTripMembers = updatedPotentialTripMembers.map(member => {
                if (obstructedTrips.some(obstructedTrip => obstructedTrip.trip_id === member.trip_id)) {
                    return {
                        ...member,
                        seat_obstruction: true,
                    };
                }
                return member;
            });

            return updatedSeatObstructedTripMembers;
        };

        const updateTripObstructedTrips = async (npt, updatedSeatObstructedTripMembers) => {
            let notInMatchedTrips;
            let notInPotentialTrips;
            const obstructedTrips = updatedSeatObstructedTripMembers.filter(member => {
                // Exclude newTripData itself
                if (member.trip_id === newTripData.trip_id) return false;

                // Check if the member properly matches newTripData by looking at its matched_trips and potential_trips
                const properMatch = newTripData.potential_trips.some(potentialTrip => potentialTrip.trip_id === member.trip_id && potentialTrip.proper_match === true);

                notInPotentialTrips = newTripData.potential_trips.some(pt => pt.trip_id !== member.trip_id);
                notInMatchedTrips = newTripData.matched_trips.some(mt => mt.trip_id !== member.trip_id);
                return !properMatch || (notInMatchedTrips && notInPotentialTrips);
            });

            const updatedTripObstructedTripMembers = await Promise.all(updatedSeatObstructedTripMembers.map(async (member) => {
                if (obstructedTrips.some(trip => trip.trip_id === member.trip_id)) {
                    const obstructingTripMembers = member.obstructing_trip_members || [];
                    notInPotentialTrips = newTripData.potential_trips.some(pt => pt.trip_id !== member.trip_id);
                    notInMatchedTrips = newTripData.matched_trips.some(mt => mt.trip_id !== member.trip_id);
                    return {
                        ...member,
                        trip_obstruction: true,
                        unknown_trip_obstruction: (notInMatchedTrips && notInPotentialTrips),
                        obstructing_trip_members: [
                            ...obstructingTripMembers,
                            {
                                trip_id: npt.trip_id,
                                pickup_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null: await calculatePickupOverlapGapWithNpt(member, npt),
                                destination_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null : await calculateDestinationOverlapGapWithNpt(member, npt),
                                unknown: (notInMatchedTrips && notInPotentialTrips),
                            },
                        ],
                    };
                }
                return member;
            }));

            return updatedTripObstructedTripMembers;
        };

        const updateOriginallyObstructedTrips = async (choiceTGMembers, originallyObstructedTrips, totalSeatCount) => {
            for (const oot of originallyObstructedTrips) {
                const [ootData, ootDocRef] = await getOldTripData(oot.trip_id, oot.user_id);

                await ootDocRef.update({
                    potential_trips: ootData.potential_trips.map((pt) =>{
                        if (choiceTGMembers.some((tgm) => tgm.trip_id === pt.trip_id)) {
                            return {
                                ...pt,
                                total_seat_count: totalSeatCount,
                            };
                        }
                        return pt;
                    }),
                });
            }
        };

        const updateNewlyObstructedTrips = async (choiceTripGroupData, newlyObstructedTrips, choiceTGMembers) => {
            for (const trip of newlyObstructedTrips) {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);

                // Delete choiceTG members from matched_trips
                const updatedMatchedTrips = oldTripData.matched_trips.filter(matchedTrip =>
                    !choiceTGMembers.some(member => member.trip_id === matchedTrip.trip_id),
                );

                // Add choiceTG members to potential_trips
                const updatedPotentialTrips = [
                    ...oldTripData.potential_trips,
                    ...(choiceTGMembers.filter(member =>
                        oldTripData.matched_trips.some(mt => mt.trip_id === member.trip_id),
                    ).map(member => ({
                        trip_id: member.trip_id,
                        paid: true,
                        trip_group_id: choiceTripGroupData.trip_group_id,
                        pickup_radius: member.pickup_radius, // Replace with actual logic
                        destination_radius: member.destination_radius, // Replace with actual logic
                        pickup_distance: oldTripData.matched_trips.find((mt) => mt.trip_id === member.trip_id).pickup_distance,
                        destination_distance: oldTripData.matched_trips.find((mt) => mt.trip_id === member.trip_id).destination_distance,
                        proper_match: true,
                        trip_obstruction: choiceTripGroupData.potential_trip_members.find((pt) => pt.trip_id === oldTripData.trip_id).trip_obstruction,
                        seat_obstruction: choiceTripGroupData.potential_trip_members.find((pt) => pt.trip_id === oldTripData.trip_id).seat_obstruction,
                        reserving_trip_id: false,
                        mutual: !oldTripData.matched_trips.find((mt) => mt.trip_id === member.trip_id).mutual, // Invert the mutual value
                        group_largest_pickup_overlap_gap: calculateOverlapGap(choiceTripGroupData)[0], // Calculate overlap if applicable
                        group_largest_destination_overlap_gap: calculateOverlapGap(choiceTripGroupData)[1],
                        unknown_trip_obstruction: choiceTripGroupData.potential_trip_members.find((pt) => pt.trip_id === oldTripData.trip_id).unknown_trip_obstruction, // Add logic if applicable
                    }))),
                ];
                await oldTripDocRef.update({
                    status: updatedMatchedTrips.length > 0 ? "matched" : "unmatched",
                    matched_trips: updatedMatchedTrips,
                    potential_trips: updatedPotentialTrips,
                });
            }

            for (const trip of choiceTGMembers) {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);

                await oldTripDocRef.update({
                    matched_trips: oldTripData.matched_trips.map((mt) => {
                        if (newlyObstructedTrips.some(trip => trip.trip_id === mt.trip_id)) {
                            return {...mt, mutual: !mt.mutual};
                        }
                        return mt;
                    }),
                    potential_trips: oldTripData.potential_trips.map((pt) => {
                        if (newlyObstructedTrips.some(trip => trip.trip_id === pt.trip_id)) {
                            return {...pt, mutual: !pt.mutual};
                        }
                        return pt;
                    }),
                });
            }
        };

        const addNPTTripsToChoiceTG = async (choiceTripGroupDocRef, choiceTripGroupData, npt, nptMatchedTrips, nptPotentialTrips, totalSeatCount) => {
            let hasUnkown;
            const newPotentialTripMembers = await Promise.all([
                ...nptMatchedTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id)),
                ...nptPotentialTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id)),
            ].map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                trip_id: trip.trip_id,
                obstructing_trip_members: trip.proper_match ? [
                    ...(await Promise.all(choiceTripGroupData.trip_group_members.filter(member => member.trip_id !== npt.trip_id)
                    .map(async (member) => {
                        const notInPotentialTrips = oldTripData.potential_trips.some(pt => pt.trip_id !== member.trip_id);
                        const notInMatchedTrips = oldTripData.matched_trips.some(mt => mt.trip_id !== member.trip_id);
                        (notInMatchedTrips && notInPotentialTrips) ? hasUnkown = true: hasUnkown = false;
                        return {
                        trip_id: member.trip_id,
                        pickup_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null: await calculatePickupOverlapGap(trip, member),
                        destination_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null: await calculateDestinationOverlapGap(trip, member),
                        unknown: (notInMatchedTrips && notInPotentialTrips),
                };
                }))), {
                    trip_id: npt.trip_id,
                    pickup_overlap_gap: await calculatePickupOverlapGapWithNpt(trip, npt),
                    destination_overlap_gap: await calculateDestinationOverlapGapWithNpt(trip, npt),
                    unknown: false,
                }] : [
                    ...(await Promise.all(choiceTripGroupData.trip_group_members.filter(member => member.trip_id !== npt.trip_id)
                    .map(async (member) => {
                        const notInPotentialTrips = oldTripData.potential_trips.some(pt => pt.trip_id !== member.trip_id);
                        const notInMatchedTrips = oldTripData.matched_trips.some(mt => mt.trip_id !== member.trip_id);
                        return {
                        trip_id: member.trip_id,
                        pickup_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null: await calculatePickupOverlapGap(trip, member),
                        destination_overlap_gap: (notInMatchedTrips && notInPotentialTrips) ? null: await calculateDestinationOverlapGap(trip, member),
                        unknown: (notInMatchedTrips && notInPotentialTrips),
                };
                })))],
                trip_obstruction: true,
                seat_obstruction: trip.seat_count > (4 - totalSeatCount),
                seat_count: trip.seat_count,
                unknown_trip_obstruction: hasUnkown,
            };
        }));

            await choiceTripGroupDocRef.update({
                potential_trip_members: [
                    ...choiceTripGroupData.potential_trip_members,
                    ...newPotentialTripMembers,
                ],
            });
        };

        const updateNewlyObstructedMatchedTripsFromNPT = async (choiceTripGroupDocRef, npt, nptMatchedTrips, nptPotentialTrips, totalSeatCount) => {
            const choiceTripGroupDoc = await choiceTripGroupDocRef.get();
            const choiceTripGroupData = choiceTripGroupDoc.data();

            const filteredMatchedTrips = [
                ...nptMatchedTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===true && (!isProperMatchWithTripGroupMembers(choiceTripGroupData, trip) || trip.seat_count > (4 - totalSeatCount))),
            ];

            const altFilteredMatchedTrips = [
                ...nptMatchedTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===true && (isProperMatchWithTripGroupMembers(choiceTripGroupData, trip) || trip.seat_count < (4 - totalSeatCount))),
            ];

            const alt2FilteredMatchedTrips = [
                ...nptMatchedTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===false),
            ];

            const filteredPotentialTrips = [
                ...nptPotentialTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===false && (!isProperMatchWithTripGroupMembers(choiceTripGroupData, trip) || trip.seat_count > (4 - totalSeatCount))),
            ];

            const altFilteredPotentialTrips = [
                ...nptPotentialTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===false && (isProperMatchWithTripGroupMembers(choiceTripGroupData, trip) || trip.seat_count < (4 - totalSeatCount))),
            ];

            const alt2FilteredPotentialTrips = [
                ...nptPotentialTrips.filter(trip => !choiceTripGroupData.trip_members.some(member => member.trip_id === trip.trip_id) && trip.mutual===true),
            ];

            const updatedMatchedTrips = await Promise.all([...filteredMatchedTrips, ...filteredPotentialTrips].map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                matched_trips: oldTripData.matched_trips.filter(mt => mt.trip_id !== tripId),
                potential_trips: [
                    ...oldTripData.potential_trips,
                    {
                        trip_id: npt.trip_id,
                        paid: true,
                        trip_group_id: npt.trip_group_id,
                        pickup_radius: npt.pickup_radius, // Replace with actual value
                        destination_radius: npt.destination_radius, // Replace with actual value
                        pickup_distance: trip.matched_trips.find((mt) => mt.trip_id === npt.trip_id).pickup_distance, // Replace with actual value
                        destination_distance: trip.matched_trips.find((mt) => mt.trip_id === npt.trip_id).destination_distance,
                        proper_match: true,
                        trip_obstruction: isProperMatchWithTripGroupMembers(choiceTripGroupData, trip),
                        seat_obstruction: trip.seat_count > (4 - totalSeatCount),
                        reserving_trip_obstruction: false,
                        mutual: false,
                        group_largest_pickup_overlap_gap: calculateOverlapGap(choiceTripGroupData)[0],
                        group_largest_destination_overlap_gap: calculateOverlapGap(choiceTripGroupData)[1],
                        unknown_trip_obstruction: choiceTripGroupData.potential_trip_members.find((pt) => pt.trip_id === oldTripData.trip_id).unknown_trip_obstruction,
                    },
                ],
                };
            }));

            const altUpdatedMatchedTrips = await Promise.all([...altFilteredMatchedTrips, ...altFilteredPotentialTrips].map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                matched_trips: oldTripData.matched_trips.map(nmt => {
                    if (nmt.trip_id === tripId) {
                        return {...nmt,
                            paid: true,
                            trip_group_id: choiceTripGroupData.trip_group_id,
                        };
                    }
                    return nmt;
                }),
                };
            }));

            const alt2UpdatedPotentialTrips = await Promise.all([...alt2FilteredMatchedTrips, ...alt2FilteredPotentialTrips].map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                potential_trips: oldTripData.potential_trips.map(npt => {
                    if (npt.trip_id === tripId) {
                        return {...npt,
                            paid: true,
                            trip_group_id: choiceTripGroupData.trip_group_id,
                            trip_obstruction: true,
                            seat_obstruction: trip.seat_count > 4 - totalSeatCount,
                            reserving_trip_obstruction: false,
                            group_largest_pickup_overlap_gap: calculateOverlapGap(choiceTripGroupData)[0],
                            group_largest_destination_overlap_gap: calculateOverlapGap(choiceTripGroupData)[1], unknown_trip_obstruction: choiceTripGroupData.potential_trip_members.find((pt) => pt.trip_id === oldTripData.trip_id).unknown_trip_obstruction,
                            total_seat_count: totalSeatCount,
                        };
                    }
                    return npt;
                }),
                };
            }));

            await Promise.all(updatedMatchedTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    status: trip.matched_trips.length > 0 ? "matched" : "unmatched",
                    potential_trips: trip.potential_trips,
                    matched_trips: trip.matched_trips,
                });
            }));

            await Promise.all(altUpdatedMatchedTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    matched_trips: trip.matched_trips,
                });
            }));

            await Promise.all(alt2UpdatedPotentialTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    potential_trips: trip.potential_trips,
                });
            }));

            const updatedMatchedArray = newTripData.matched_trips.map(nmt => {
                if (filteredMatchedTrips.map((fmt) => fmt.trip_id).includes(nmt.trip_id)) {
                    return {...nmt,
                        mutual: false,
                    };
                }
                return nmt;
            });

            const updatedPotentialArray = newTripData.potential_trips.map(nmt => {
                if (filteredPotentialTrips.map((fmt) => fmt.trip_id).includes(nmt.trip_id)) {
                    return {...nmt,
                        mutual: true,
                    };
                }
                return nmt;
            });

            await newTripDocRef.update({
                matched_trips: updatedMatchedArray,
                potential_trips: updatedPotentialArray,
            });
        };
        const generateObstructingTripMembersFromGroupWithJustNpt = async (oldTrip) => {
           const obstructingMembers = [];
            if (!isProperMatch(newTripData, oldTrip)) {
                obstructingMembers.push({
                    trip_id: oldTrip.trip_id,
                    pickup_overlap_gap: await calculatePickupOverlapGapWithNpt(oldTrip, newTripData),
                    destination_overlap_gap: await calculateDestinationOverlapGapWithNpt(oldTrip, newTripData),
                    unknown: false,
                });
            }
            return obstructingMembers;
        };

        const createNewTripGroup = async () => {
            const newTripGroupDocRef = db.collection("trip_groups").doc();
            await newTripGroupDocRef.set({
                trip_group_id: newTripDocRef.id,
                trip_group_members: [
                    {
                        trip_id: newTripData.trip_id,
                        first_name: newTripData.first_name,
                        phone_number: newTripData.phone_number,
                        photo_url: newTripData.photo_url,
                        seat_count: newTripData.seat_count,
                    },
                ],
                potential_trip_members: await Promise.all([...newTripData.matched_trips, ...newTripData.potential_trips].map(async (trip) => {
                    return {
                        trip_id: trip.trip_id,
                        obstructing_trip_members: await generateObstructingTripMembersFromGroupWithJustNpt(trip),
                        trip_obstruction: isProperMatch(newTripData, trip),
                        seat_obstruction: false,
                        seat_count: trip.seat_count,
                        unknown_trip_obstruction: false,
                    };
                })),
                total_seat_count: 0,
                pickup_location_suggestions: [],
                destination_suggestions: [],
            });

            const tripGroupId = newTripGroupDocRef.id;
            const newTripGroupDocRef2 = await db.collection("trip_groups").doc(tripGroupId).get();
            const newTripGroupData = newTripGroupDocRef2.data();

            await newTripDocRef.update({
                trip_group_id: newTripGroupDocRef.id,
                total_seat_count: newTripData.seat_count,
            });

            const filteredMatchedTrips = [
                ...newTripData.matched_trips.filter(trip => trip.mutual===true),
                ...newTripData.potential_trips.filter(trip => trip.mutual===false),
            ];

            const filteredPotentialTrips = [
                ...newTripData.matched_trips.filter(trip => trip.mutual===false),
                ...newTripData.potential_trips.filter(trip => trip.mutual===true),
            ];

            const updatedMatchedTrips = await Promise.all(filteredMatchedTrips.map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                matched_trips: oldTripData.matched_trips.map(nmt => {
                    if (nmt.trip_id === tripId) {
                        return {...nmt,
                            paid: true,
                            trip_group_id: tripGroupId,
                        };
                    }
                    return nmt;
                }),
                };
            }));

            const updatedPotentialTrips = await Promise.all(filteredPotentialTrips.map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                potential_trips: oldTripData.potential_trips.map(npt => {
                    if (npt.trip_id === tripId) {
                        return {...npt,
                            paid: true,
                            trip_group_id: tripGroupId,
                            trip_obstruction: true,
                            reserving_trip_obstruction: false,
                            group_largest_pickup_overlap_gap: calculateOverlapGap(newTripGroupData)[0],
                            group_largest_destination_overlap_gap: calculateOverlapGap(newTripGroupData)[1],
                            total_seat_count: newTripData.seat_count,
                        };
                    }
                    return npt;
                }),
                };
            }));

            await Promise.all(updatedMatchedTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    matched_trips: trip.matched_trips,
                });
            }));

            await Promise.all(updatedPotentialTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    potential_trips: trip.potential_trips,
                });
            }));

            let minTotalDistance = Infinity;
            let closestMatchedTrips = [];

            for (const mt of newTripData.matched_trips) {
                const totalPickupDistance = mt.pickup_distance;
                const totalDestinationDistance = mt.destination_distance;

                const totalDistance = totalPickupDistance + totalDestinationDistance;

                if (totalDistance < minTotalDistance) {
                    minTotalDistance = totalDistance;
                    closestMatchedTrips = [mt];
                } else if (totalDistance === minTotalDistance) {
                    closestMatchedTrips.push(mt);
                }
            }

            const randomIndex = Math.floor(Math.random() * closestMatchedTrips.length);
            const [reservedTripData, reservedTripDocRef] = await getOldTripData(closestMatchedTrips[closestMatchedTrips.length===1 ? 0 : randomIndex].trip_id, closestMatchedTrips[closestMatchedTrips.length===1 ? 0 : randomIndex].user_id);
            reservedTripDocRef.update({
                reserved: true,
                reserving_trip_id: tripId,
                reserving_trip_user_id: userId,
            });

            newTripDocRef.update({
                matched_trips: newTripData.matched_trips.map(mt => {
                    if (mt.trip_id === reservedTripData.trip_id) {
                        return {...mt,
                            reserving: true,
                        };
                    }
                    return mt;
                }),
            });

            const altFilteredMatchedTrips = [
                ...reservedTripData.matched_trips.filter(trip => trip.mutual===true && !isProperMatch(newTripData, trip)),
                ...reservedTripData.potential_trips.filter(trip => trip.mutual===false && !isProperMatch(newTripData, trip)),
            ];

            const altFilteredPotentialTrips = [
                ...reservedTripData.matched_trips.filter(trip => trip.mutual===false && !isProperMatch(newTripData, trip)),
                ...reservedTripData.potential_trips.filter(trip => trip.mutual===true && !isProperMatch(newTripData, trip)),
            ];

            const altUpdatedMatchedTrips = await Promise.all(altFilteredMatchedTrips.map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                matched_trips: oldTripData.matched_trips.filter(mt => mt.trip_id !== reservedTripData.trip_id),
                potential_trips: [
                    ...oldTripData.potential_trips,
                    {
                        trip_id: reservedTripData.trip_id,
                        paid: false,
                        trip_group_id: "",
                        pickup_radius: reservedTripData.pickup_radius, // Replace with actual value
                        destination_radius: reservedTripData.destination_radius, // Replace with actual value
                        pickup_distance: trip.matched_trips.find((mt) => mt.trip_id === reservedTripData.trip_id).pickup_distance, // Replace with actual value
                        destination_distance: trip.matched_trips.find((mt) => mt.trip_id === reservedTripData.trip_id).destination_distance,
                        proper_match: true,
                        trip_obstruction: false,
                        seat_obstruction: false,
                        reserving_trip_obstruction: true,
                        mutual: !trip.matched_trips.find(mt => mt.trip_id === reservedTripData.trip_id).mutual,
                        group_largest_pickup_overlap_gap: null,
                        group_largest_destination_overlap_gap: null,
                        unknown_trip_obstruction: false,
                    },
                ],
                };
            }));

            const altUpdatedPotentialTrips = await Promise.all(altFilteredMatchedTrips.map(async (trip) => {
                const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);
                return {
                ...oldTripData,
                potential_trips: oldTripData.potential_trips.map(npt => {
                    if (npt.trip_id === reservedTripData.trip_id) {
                        return {...npt,
                            reserving_trip_obstruction: true,
                        };
                    }
                    return npt;
                }),
                };
            }));
            await Promise.all(altUpdatedMatchedTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    status: trip.matched_trips.length > 0 ? "matched" : "unmatched",
                    potential_trips: trip.potential_trips,
                    matched_trips: trip.matched_trips,
                });
            }));

            await Promise.all(altUpdatedPotentialTrips.map(async trip => {
                const tripDocRef = db.collection(`users/${trip.user_id}trips`).doc(trip.trip_id);
                await tripDocRef.update({
                    potential_trips: trip.potential_trips,
                });
            }));

            const updatedMatchedArray = reservedTripData.matched_trips.map(nmt => {
                if (reservedTripData.matched_trips.filter(trip => trip.mutual===true && !isProperMatch(newTripData, trip)).map((fmt) => fmt.trip_id).includes(nmt.trip_id)) {
                    return {...nmt,
                        mutual: false,
                    };
                }
                return nmt;
            });

            const updatedPotentialArray = reservedTripData.potential_trips.map(nmt => {
                if (reservedTripData.potential_trips.filter(trip => trip.mutual===false && !isProperMatch(newTripData, trip)).map((fmt) => fmt.trip_id).includes(nmt.trip_id)) {
                    return {...nmt,
                        mutual: true,
                    };
                }
                return nmt;
            });

            await reservedTripDocRef.update({
                matched_trips: updatedMatchedArray,
                potential_trips: updatedPotentialArray,
            });
        };


        try {
            if (newTripData.reserved === true) {
                const [oldTripData, oldTripDocRef] = await getOldTripData(newTripData.reserving_trip_id, newTripData.reserving_trip_user_id);
                const oldTripGroupData = await getOldTripGroupData(oldTripData.trip_group_id);
                await newTripDocRef.update({
                    trip_group_id: oldTripData.trip_group_id,
                    total_seat_count: newTripData.seat_count + oldTripGroupData.total_seat_count,
                    reserved: false,
                    reserving_trip_id: del(),
                });
                const updatedArray = oldTripData.matched_trips.map(mt => {
                    if (mt.trip_id === tripId) {
                        return {...mt,
                            trip_group_id: oldTripData.trip_group_id,
                            paid: true,
                            reserving: false,
                        };
                    }
                    return mt;
                });

                await oldTripDocRef.update({
                    total_seat_count: newTripData.seat_count + oldTripGroupData.total_seat_count,
                    matched_trips: updatedArray,
                });
            } else {
                choiceTripGroup = await getChoiceTripGroup();
                if (choiceTripGroup === null) {
                    await createNewTripGroup();
                }
                await newTripDocRef.update({
                    trip_group_id: choiceTripGroup.trip_group_id,
                    total_seat_count: newTripData.seat_count + choiceTripGroup.total_seat_count,
                });
                if (choiceTripGroup.trip_group_members.length === 1) {
                    const reservedTrip = await updateSoleTripGroupMember(choiceTripGroup.trip_group_members[0]);

                    if (!reservedTrip) {
                        console.log("No reserved trip found.");
                        return;
                    }

                    const specificTrips = getTripsThatHaveReservedTripInPotentialTrips(reservedTrip);

                    const tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue = await Promise.all(specificTrips.map(async (trip) => {
                        const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                        const tripData = tripDoc.data();
                        const hasObstructionTrueAndProperMatchFalse = tripData.potential_trips.some((potentialTrip) => {
                            return potentialTrip.trip_id === reservedTrip.trip_id && potentialTrip.obstruction === true && potentialTrip.proper_match === true;
                        });
                        return hasObstructionTrueAndProperMatchFalse ? {tripData, trip} : null;
                    })).filter(result => result !== null);

                    const tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchFalse = await Promise.all(specificTrips.map(async (trip) => {
                        const tripDoc = await db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id).get();
                        const tripData = tripDoc.data();
                        const hasObstructionTrueAndProperMatchFalse = tripData.potential_trips.some((potentialTrip) => {
                            return potentialTrip.trip_id === reservedTrip.trip_id && potentialTrip.obstruction === true && potentialTrip.proper_match === false;
                        });
                        return hasObstructionTrueAndProperMatchFalse ? {tripData, trip} : null;
                    })).filter(result => result !== null);

                    for (const {tripData, trip} of tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchFalse) {
                        const tripDocRef = db.collection(`users/${trip.user_id}/trips`).doc(trip.trip_id);
                        await tripDocRef.update({
                            "potential_trips": tripData.potential_trips.map((pt) => {
                                if (pt.trip_id === reservedTrip.trip_id) {
                                    return {
                                        ...pt,
                                        reserving_trip_obstruction: false,
                                    };
                                }
                                return pt;
                            }),
                        });
                    }

                    await updateMatchingTrips(reservedTrip, tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue);

                    await updateReservedTrip(reservedTrip, tripsThatHaveReservedTripInPotentialTripsAlongWithObstructionTrueAndProperMatchTrue);
                }
                await updateChoiceTripGroupMembers(choiceTripGroup, newTripData);
            }

            const choiceTripGroupDocRef = db.collection("trip_groups").doc(choiceTripGroup.trip_group_id);
            let choiceTripGroupDoc = await choiceTripGroupDocRef.get();
            let choiceTripGroupData = choiceTripGroupDoc.data();
            const currentPotentialTripMembers = choiceTripGroupData.potential_trip_members;
            const membersWithUpdatedObstruction = [];
            const originallyObstructedTrips = [];

            const [updatedTotalSeatCount, updatedPotentialTripMembers, newTripGroupMember] = await updateChoiceTripGroupWithNPT(choiceTripGroupData, newTripData);

            const updatedSeatObstructedTripMembers = await updateSeatObstructedTrips(updatedTotalSeatCount, updatedPotentialTripMembers);

            const updatedTripObstructedTripMembers = await updateTripObstructedTrips(newTripData, updatedSeatObstructedTripMembers);

            for (const member of updatedTripObstructedTripMembers) {
                const oldMember = currentPotentialTripMembers.find(m => m.trip_id === member.trip_id);
                if (oldMember && (
                    (oldMember.seat_obstruction === false && member.seat_obstruction === true) ||
                    (oldMember.trip_obstruction === false && member.trip_obstruction === true)
                )) {
                    membersWithUpdatedObstruction.push(member);
                }
            }

            for (const member of updatedTripObstructedTripMembers) {
                const oldMember = currentPotentialTripMembers.find(m => m.trip_id === member.trip_id);
                if (oldMember && (
                    (oldMember.seat_obstruction === true && member.seat_obstruction === true) ||
                    (oldMember.trip_obstruction === true && member.trip_obstruction === true)
                )) {
                    originallyObstructedTrips.push(member);
                }
            }

            await choiceTripGroupDocRef.update({
                total_seat_count: updatedTotalSeatCount,
                potential_trip_members: updatedTripObstructedTripMembers,
                trip_group_members: [...choiceTripGroupData.trip_group_members, newTripGroupMember],
            });

            choiceTripGroupDoc = await choiceTripGroupDocRef.get();
            choiceTripGroupData = choiceTripGroupDoc.data();

            await updateOriginallyObstructedTrips(choiceTripGroupData.trip_group_members, originallyObstructedTrips, updatedTotalSeatCount);

            await updateNewlyObstructedTrips(choiceTripGroupData, membersWithUpdatedObstruction, choiceTripGroupData.trip_group_members);

            await addNPTTripsToChoiceTG(choiceTripGroupDocRef, choiceTripGroupData, newTripData, newTripData.matched_trips, newTripData.potential_trips, updatedTotalSeatCount);

            await updateNewlyObstructedMatchedTripsFromNPT(choiceTripGroupDocRef, newTripData, newTripData.matched_trips, newTripData.potential_trips, updatedTotalSeatCount);

            const tripGroupMembersData = await Promise.all(
                choiceTripGroupData.trip_group_members.map(async (member) => {
                    const oldTripData = await getOldTripData(member.trip_id);
                    return oldTripData[0];
                }),
            );

            const pickupLocations = tripGroupMembersData.map((member) => member.pickup_latlng);
            const destinationLocations = tripGroupMembersData.map((member) => member.destination_latlng);

            const pickupCentroid = calculateCentroid(pickupLocations);
            const destinationCentroid = calculateCentroid(destinationLocations);

            const pickupDistances = pickupLocations.map((loc) => calculateDistance(loc, pickupCentroid));
            const destinationDistances = destinationLocations.map((loc) => calculateDistance(loc, destinationCentroid));

            const farthestPickup = pickupLocations[pickupDistances.indexOf(Math.max(...pickupDistances))];
            const farthestDestination = destinationLocations[destinationDistances.indexOf(Math.max(...destinationDistances))];

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
        } catch (error) {
          console.error(error);
          throw new Error("Trip could not match at the second stage");
        }
      } catch (error) {
        console.error("Function execution halted:", error);
        return null;
      }
    });
