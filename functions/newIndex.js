/* eslint-disable linebreak-style */
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
const {onDocumentCreated} = require("firebase-functions/v2/firestore");

// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const axios = require("axios");
const db = getFirestore();


initializeApp();

db.settings({ignoreUndefinedProperties: true});


exports.matchingFunction = onDocumentCreated("users/{userId}/trips/{tripId}",
    async (event) => {
      try {
        const arrayUnion = db.FieldValue.arrayUnion;
        const userId = event.params.userId;
        const tripId = event.params.tripId;
        const newTripDocRef = db.collection(`users/${userId}/trips`).doc(tripId);
        const snapshot = event.data;
        if (!snapshot) {
          console.log("No data associated with the event");
          return;
        }
        const newTripData = snapshot.data();
        console.log(newTripData);
        console.log(typeof newTripData.start_date_time);
        const firstStageTrips = [];
        let nextBatch;
        let pickupMatches;
        let matchedTrips;
        let pickupDistance;
        let destinationDistance;
        // let secondStageTrips = [];
        // let thirdStageTrips = [];
        // const fourthStageTrips = [];
        // const finalStageTrips = [];

        // const matchedTrips = [];
        // const newMatchedTripData = [];
        // // const poolRef = db.collection("pools");
        // const apiKey = process.env.API_KEY;
        // const distanceMatrixApiKey = process.env.DISTANCE_MATRIX_API_KEY;

        const setNewTripStatus = async (status) => {
            await newTripDocRef.update({status: status});
        };

        const setOldTripStatus = async (tripId, status) => {
            const oldTripRef = db.collectionGroup("trips").doc(tripId);
            oldTripRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trips`)
                        .doc(tripId);
                    await oldTripDocRef.update({status: status});
                }
            });
        };

        const isProperMatch = (potentialTrip, newTripData) => {
            //unkown trip check
            return (
                newTripData.pickup_radius + potentialTrip.pickup_radius >= 150 &&
                newTripData.destination_radius + potentialTrip.destination_radius >= 150
            );
        };fi

        const isProperMatchWithTripGroupMembers = (tripGroupId) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    const groupMembers = oldTripGroupData.trip_group_members.map((member) => member.trip_id);

                    if (groupMembers.every((memberTripId) => {
                        const trip = db
                        .collection(`users/${userId}/trips`)
                        .doc(memberTripId).get.docs.data();
                        isProperMatch(trip, newTripData);
                    })) {
                        return true;
                    } else {
                        return false;
                    }
                }
            });
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

        const updateNewTripPotentialTrips = async (tripData, {paid=false, proper_match=false, trip_obstruction=false, seat_obstruction=false, reserved=false, mutual=false, group_largest_pickup_overlap_gap=null, group_largest_destination_overlap_gap=null}) => {
            await newTripDocRef.update({
                potential_trips: arrayUnion({
                    ...tripData,
                    paid,
                    proper_match,
                    trip_obstruction,
                    seat_obstruction,
                    reserved,
                    mutual,
                    group_largest_pickup_overlap_gap,
                    group_largest_destination_overlap_gap,
                }),
            });
        };

        const updateOldTripPotentialTrips = async (tripId, tripData, {paid=false, proper_match=false, trip_obstruction=false, seat_obstruction=false, reserved=false, mutual=false, group_largest_pickup_overlap_gap=null, group_largest_destination_overlap_gap=null}) => {
            const oldTripRef = db.collectionGroup("trips").doc(tripId);
            oldTripRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trips`)
                        .doc(tripId);
                    await oldTripDocRef
                        .update({
                            potential_trips: db.FieldValue.arrayUnion({
                                ...tripData,
                                paid,
                                proper_match,
                                trip_obstruction,
                                seat_obstruction,
                                reserved,
                                mutual,
                                group_largest_pickup_overlap_gap,
                                group_largest_destination_overlap_gap,
                            }),
                        });
                }
            });
        };

        const updateNewTripMatchedTrips = async (tripData, {paid, mutual, reserving=false}) => {
            await newTripDocRef.update({
                matched_trips: arrayUnion({
                    trip_id: tripData.trip_id,
                    trip_group_id: tripData.trip_group_id,
                    paid,
                    pickup_radius: tripData.pickup_radius,
                    destination_radius: tripData.destination_radius,
                    pickup_distance: tripData.pickup_distance,
                    destination_distance: tripData.destination_distance,
                    mutual,
                    reserving,
                }),
            });
        };

        const updateOldTripMatchedTrips = async (tripId, tripData, {paid=false, mutual=false, reserving=false}) => {
            const oldTripRef = db.collectionGroup("trips").doc(tripId);
            oldTripRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trips`)
                        .doc(tripId);
                    await oldTripDocRef
                        .update({
                            matched_trips: db.FieldValue.arrayUnion({
                                trip_id: tripData.trip_id,
                                trip_group_id: tripData.trip_group_id,
                                paid,
                                pickup_radius: tripData.pickup_radius,
                                destination_radius: tripData.destination_radius,
                                pickup_distance: tripData.pickup_distance,
                                destination_distance: tripData.destination_distance,
                                mutual,
                                reserving,
                            }),
                        });
                }
            });
        };

        const checkRemaningSeats = async (tripGroupId, newTripData) => {
            const oldTripRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripDoc = await oldTripDocRef.get();
                    const oldTripData = oldTripDoc.docs.data();
                    const remainingSeats = 4 - oldTripData.total_seat_count;
                    if (remainingSeats >= newTripData.seat_count) {
                        return true;
                    } else {
                        return false;
                    }
                }
            });
        };

        const generateMatchedTripMembersFromGroup = (tripGroupId) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    const groupMembers = oldTripGroupData.trip_group_members.map((member) => member.trip_id);

                   const memberId = groupMembers.map((memberTripId) => {
                        const trip = db
                        .collection(`users/${userId}/trips`)
                        .doc(memberTripId).get.docs.data();
                        if (isProperMatch(trip, newTripData)) {
                            return memberTripId;
                        }
                    });
                    return memberId;
                }
            });
        };

        const generateObstructingTripMembersFromGroup = (tripGroupId) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    const groupMembers = oldTripGroupData.trip_group_members.map((member) => member.trip_id);

                   const obstructingMembers = groupMembers.map((memberTripId) => {
                        const trip = db
                        .collection(`users/${userId}/trips`)
                        .doc(memberTripId).get.docs.data();
                        if (!isProperMatch(trip, newTripData)) {
                            return {
                                trip_id: trip.trip_id,
                                pickup_overlap_gap: 150 - (newTripData.pickup_radius + trip.pickup_radius),
                                destination_overlap_gap: 150 - (newTripData.destination_radius + trip.destination_radius),
                            };
                        }
                    });
                    return obstructingMembers;
                }
            });
        };

        const checkOldTripGroupMatchedTrips = async (tripGroupId) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    if (tripId in oldTripGroupData.matched_trips) {
                        return true;
                    } else {
                        await oldTripGroupDocRef
                        .update({
                            matched_trips: db.FieldValue.arrayUnion(tripId),
                        });
                        return true;
                    }
                }
            });
        };

        const checkOldTripGroupPotentialTrips = async (tripGroupId) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupId);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupId);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    const isTripIdInPotentialTrips = oldTripGroupData.potential_trips.some((trip) => trip.trip_id === tripId);



                    if (isTripIdInPotentialTrips) {
                        return true;
                    } else {
                        await oldTripGroupDocRef
                        .update({
                            potential_trips: {
                                trip_id: tripId,
                                matched_trips: generateMatchedTripMembersFromGroup(tripGroupId),
                                obstructing_trip_members: generateObstructingTripMembersFromGroup(tripGroupId),
                                unknown: 
                            },
                        });
                        return true;
                    }
                }
            });
        };
        // const isFullyMatched = (newTripMatches, oldTripGroup) => {
        //   const newTripMatchIds = newTripMatches.map((trip) => trip.trip_id);
        //   const oldTripGroupIds = oldTripGroup.map((trip) => trip.trip_id);
        //   return newTripMatchIds.length ===
        //   oldTripGroupIds.length && newTripMatchIds
        //       .every((value) => oldTripGroupIds.includes(value));
        // };

        try {
          // Retrieve all users
          const usersSnapshot = await db.collection("users").get();

          const userTripPromises = usersSnapshot.docs.map(async (userDoc) => {
            const otherUserId = userDoc.id;

            if (otherUserId !== userId) {
              const tripsRef = db
                  .collection(`users/${otherUserId}/trips`);
              const queries = [];

              if (newTripData.isTripTimeFixed === false) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("isTripTimeFixed", "==", false)
                    .where("time_range_array", "array-contains-any",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.isTripTimeFixed === true) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("isTripTimeFixed", "==", false)
                    .where("time_range_array", "array-contains",
                        newTripData.start_date_string)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.isTripTimeFixed === false) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("isTripTimeFixed", "==", true)
                    .where("start_date_string", "in",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.isTripTimeFixed === true) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("isTripTimeFixed", "==", true)
                    .where("start_date_string", "==",
                        newTripData.start_date_string)
                    .where("fully_matched", "==", false));
              }
              // Execute the queries
              const snapshots = await Promise
                  .all(queries.map((query) => query.get()));

              // Merge the results
              const filteredTripsSnapshot = snapshots
                  .flatMap((snapshot) => snapshot.docs);

              filteredTripsSnapshot.forEach((doc) => {
                const oldTripData = doc.data();
                firstStageTrips.push(oldTripData);
              });
            }
          });
          await Promise.all(userTripPromises);

          // Check if there are any trips to match and update pickupMatches
          if (firstStageTrips.length > 0) {
            nextBatch = [];
            pickupMatches = [];

            for (let i = 0; i < firstStageTrips.length; i++) {
              nextBatch.push(firstStageTrips[i]);
              if (nextBatch.length === 625) {
                for (let i = 0; i < nextBatch.length; i++) {
                    const oldTrip = nextBatch[i];
                    const origin = `${newTripData.pickup_latlng.lat},${newTripData.pickup_latlng.lng}`;
                    const destination = `${oldTrip.pickup_latlng.lat},${oldTrip.pickup_latlng.lng}`;

                    const distanceMatrix = await getDistanceMatrix(origin, destination);
                    const distance = distanceMatrix.rows[0].elements[0].distance.value;

                    if (distance <= 10000) {
                        pickupMatches.push(oldTrip);
                        pickupDistance.push({distance: distance});
                    }
                }
                nextBatch = [];
                }
            }
            for (let i = 0; i < nextBatch.length; i++) {
                const oldTrip = nextBatch[i];
                const origin = `${newTripData.pickup_latlng.lat},${newTripData.pickup_latlng.lng}`;
                const destination = `${oldTrip.pickup_latlng.lat},${oldTrip.pickup_latlng.lng}`;

                const distanceMatrix = await getDistanceMatrix(origin, destination);
                const distance = distanceMatrix.rows[0].elements[0].distance.value;

                if (distance <= 9850) {
                    pickupMatches.push(oldTrip);
                    pickupDistance.push({distance: distance});
                }
            }
            nextBatch = [];
            } else {
                await setNewTripStatus("unmatched");
                throw new Error("No trips to match based off pickup latlng");
            }

            // Check if there are any trips to match with the pickupMatches and update matchedTrips
            if (pickupMatches.length > 0) {
                nextBatch = [];
                matchedTrips = [];

                for (let i = 0; i < pickupMatches.length; i++) {
                    nextBatch.push(pickupMatches[i]);
                    if (nextBatch.length === 625) {
                        for (let i = 0; i < nextBatch.length; i++) {
                            const oldTrip = nextBatch[i];
                            const origin = `${newTripData.destination_latlng.lat},${newTripData.destination_latlng.lng}`;
                            const destination = `${oldTrip.destination_latlng.lat},${oldTrip.destination_latlng.lng}`;

                            const distanceMatrix = await getDistanceMatrix(origin, destination);
                            const distance = distanceMatrix.rows[0].elements[0].distance.value;

                            if (distance <= 10000) {
                                matchedTrips.push(oldTrip);
                                destinationDistance.push({distance: distance});
                            }
                        }
                        nextBatch = [];
                    }
                }
                for (let i = 0; i < nextBatch.length; i++) {
                    const oldTrip = nextBatch[i];
                    const origin = `${newTripData.destination_latlng.lat},${newTripData.destination_latlng.lng}`;
                    const destination = `${oldTrip.destination_latlng.lat},${oldTrip.destination_latlng.lng}`;

                    const distanceMatrix = await getDistanceMatrix(origin, destination);
                    const distance = distanceMatrix.rows[0].elements[0].distance.value;

                    if (distance <= 9850) {
                        matchedTrips.push(oldTrip);
                        destinationDistance.push({distance: distance});
                    }
                }
                nextBatch = [];
            } else {
                await setNewTripStatus("unmatched");
                throw new Error("No trips to match based off destination latlng");
            }
        } catch (error) {
          console.error(error);
          throw new Error("Trip could not match at the first stage (City and Time Filter)");
        }

        try {
            if (matchedTrips.length > 0) {
                const potentialTrips = matchedTrips.map((trip, index) => {
                    return {
                        trip_id: trip.trip_id,
                        paid: false,
                        trip_group_id: trip.trip_group_id,
                        pickup_radius: trip.pickup_radius,
                        destination_radius: trip.destination_radius,
                        pickup_distance: pickupDistance[index].distance,
                        destination_distance: destinationDistance[index].distance,
                        proper_match: false,
                        trip_obstruction: false,
                        seat_obstruction: false,
                        reserved: false,
                        mutual: false,
                        group_largest_pickup_overlap_gap: null,
                        group_largest_destination_overlap_gap: null,
                    };
                });
                matchedTrips.forEach(async (trip, index) => {
                    // const tripDocRef = db.collection(`users/${userId}/trips`).doc(trip.tripId);
                    // const tripDoc = await tripDocRef.get();
                    // const tripData = tripDoc.data();
                    if (trip.status === "matched" || trip.status === "unmatched" ) {
                        if (isProperMatch(trip, newTripData) && trip.reserved === "false") {
                            setOldTripStatus(trip.trip_id, "matched");

                            setNewTripStatus("matched");

                            updateNewTripMatchedTrips(potentialTrips[index], {paid: false, reserving: false, mutual: true});

                            updateOldTripMatchedTrips(trip.trip_id, newTripData, {paid: false, reserving: false, mutual: true});
                        } else if (isProperMatch(trip, newTripData) && trip.reserved === "true") {
                            if (trip.matched_trips.every((matchedTrip) => isProperMatch(matchedTrip, newTripData) && matchedTrip.reserving === false)) {
                                updateNewTripMatchedTrips(potentialTrips[index], {paid: false, reserving: false, mutual: true});

                                updateOldTripMatchedTrips(trip.trip_id, newTripData, {paid: false, reserving: false, mutual: true});
                            } else {
                                updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: true, trip_obstruction: false, seat_obstruction: false, reserved: true, mutual: false});

                                updateOldTripMatchedTrips(trip.trip_id, newTripData, {paid: false, reserving: false, mutual: false});
                            }
                        } else if (!isProperMatch(trip, newTripData) && trip.reserved === "false") {
                            updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserved: false, mutual: true});

                            updateOldTripPotentialTrips(trip.trip_id, newTripData, {paid: false, proper_match: false, reserved: false, trip_obstruction: false, seat_obstruction: false, mutual: true});
                        } else if (!isProperMatch(trip, newTripData) && trip.reserved === "true") {
                            updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserved: true, mutual: true});

                            updateOldTripPotentialTrips(trip.trip_id, newTripData, {paid: false, proper_match: false, reserved: false, trip_obstruction: false, seat_obstruction: false, mutual: true});
                        } else {
                            // Code to handle any other case
                        }
                    } else if (trip.status === "paid") {
                        if (isProperMatch(trip, newTripData) &&
                            isProperMatchWithTripGroupMembers(trip.trip_group_id) &&
                            checkRemaningSeats(trip.trip_group_id, newTripData)) {
                            if (checkOldTripGroupMatchedTrips(trip.trip_group_id)) {
                                setNewTripStatus("matched");
                                updateOldTripMatchedTrips(trip.trip_id, newTripData, {paid: false, reserving: false, mutual: false});

                                updateNewTripMatchedTrips(potentialTrips[index], {paid: true, reserving: false, mutual: true});
                            }
                        } else {
                            if (checkOldTripGroupPotentialTrips(trip.trip_group_id)) {
                                if (isProperMatch(trip, newTripData)) {
                                    
                                }
                            }
                        }
                    }
                });
            }
        } catch (error) {
          console.error(error);
          throw new Error("Trip could not match at the second stage");
        }
      } catch (error) {
        console.error("Function execution halted:", error);
        return null;
      }
    });
