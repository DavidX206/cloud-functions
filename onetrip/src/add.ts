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
// const {onDocumentCreated, FirestoreEvent} = require("firebase-functions/v2/firestore");
// const axios = require("axios");
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import axios from "axios";

// The Firebase Admin SDK to access Firestore.
import { db, arrayUnion } from "./firebaseAdmin";
import {ObstructingTripMember, Trip, TripGroup} from "../../type";


exports.tripAddedFunction = onDocumentCreated("users/{userId}/trips/{tripId}",
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
        const newTripData = snapshot.data() as Trip;
        console.log(newTripData);
        console.log(typeof newTripData.start_date_time);
        const firstStageTrips: Trip[] = [];
        let nextBatch;
        let pickupMatches;
        let matchedTrips: Trip[];
        let pickupDistance: {distance: number}[];
        let destinationDistance: {distance: number}[];
        let isNewTripMatched = false;
        let potentialNewTrip: PrimaryTripDetails;

        interface PrimaryTripDetails {
            trip_id: string;
            user_id: string;
            trip_group_id: string;
            pickup_radius: number;
            destination_radius: number;
            pickup_distance: number;
            destination_distance: number;
            total_seat_count: number;
        }
        // let secondStageTrips = [];
        // let thirdStageTrips = [];
        // const fourthStageTrips = [];
        // const finalStageTrips = [];

        // const matchedTrips = [];
        // const newMatchedTripData = [];
        // // const poolRef = db.collection("pools");
        // const apiKey = process.env.API_KEY;
        // const distanceMatrixApiKey = process.env.DISTANCE_MATRIX_API_KEY;

        const getOldTripData = async (tripId: string, userId: string): Promise<[Trip, FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>] | null> => {
            try {
                // Get the specific trip document reference under the user's collection
                const oldTripDocRef = db
                    .collection(`users/${userId}/trips`)
                    .doc(tripId);

                const oldTripDoc = await oldTripDocRef.get();

                if (oldTripDoc.exists) {
                    const oldTripData = oldTripDoc.data() as Trip;
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

        const setNewTripStatus = async (status: string): Promise<void> => {
            if (status === "matched") {
                isNewTripMatched = true;
            }
            await newTripDocRef.update({status: status});
        };

        const setOldTripStatus = async (tripId: string, userId: string, status: string): Promise<void> => {
            const oldTripDocRef = db
                .collection(`users/${userId}/trips`)
                .doc(tripId);
            await oldTripDocRef.update({status: status});
            console.log("A trip status has been updated");
        };

        const isProperMatch = (potentialTrip: Trip, newTripData: Trip, pickupDistance: number | null, destinationDistance: number | null): boolean => {
            if ((pickupDistance || destinationDistance) === null) {
                return false;
            }
            const isPickupWithinRadius = pickupDistance !== null && pickupDistance <= newTripData.pickup_radius && pickupDistance <= potentialTrip.pickup_radius;
            const isDestinationWithinRadius = destinationDistance !== null && destinationDistance <= newTripData.destination_radius && destinationDistance <= potentialTrip.destination_radius;
            return isPickupWithinRadius && isDestinationWithinRadius;
        };

        const isProperMatchWithTripGroupMembers = async (oldTripGroupData: TripGroup, tripData: Trip): Promise<boolean> => {
            const groupMembers = oldTripGroupData.trip_group_members.map((member) => ({trip_id: member.trip_id, user_id: member.user_id}));

            for (const member of groupMembers) {
                const mtIndex = matchedTrips.findIndex((mt) => mt.trip_id === member.trip_id);
                const mt = mtIndex !== -1 ? matchedTrips[mtIndex] : null;
                
                const pD = mt ? pickupDistance[mtIndex] : null;
                const dD = mt ? destinationDistance[mtIndex] : null;
            
                const tripDoc = await db
                  .collection(`users/${member.user_id}/trips`)
                  .doc(member.trip_id)
                  .get();
            
                const trip = tripDoc.data() as Trip;
                
                if (!isProperMatch(trip, tripData, pD?.distance ?? null, dD?.distance ?? null)) {
                  return false;
                }
              }
              return true;
        };


        const getDistanceMatrix = async (origins: string, destinations: string) => {
            const apiKey = "prj_test_pk_588209ad32c07e27f4f06195c2fe701c0d63ea77";
            const url = `https://api.radar.io/v1/route/matrix?origins=${origins}&destinations=${destinations}&units=metric`;

            try {
                const response = await axios.get(url, {
                    headers: {
                        Authorization: `${apiKey}`,
                    },
                });
                return response.data;
            } catch (error) {
                console.error("Error calling Radar Route Matrix API:", error);
                throw new Error("Failed to retrieve route matrix");
            }
        };

        const updateNewTripPotentialTrips = async (tripData: PrimaryTripDetails, {paid=false, proper_match=false, trip_obstruction=false, seat_obstruction=false, reserving_trip_obstruction=false, mutual=false, group_largest_pickup_overlap_gap = null as number | null, group_largest_destination_overlap_gap = null as number | null, unknown_trip_obstruction=false}): Promise<void> => {
            await newTripDocRef.update({
                potential_trips: arrayUnion({
                    ...tripData,
                    paid,
                    proper_match,
                    trip_obstruction,
                    seat_obstruction,
                    reserving_trip_obstruction,
                    mutual,
                    group_largest_pickup_overlap_gap,
                    group_largest_destination_overlap_gap,
                    unknown_trip_obstruction,
                }),
            });
        };

        const updateOldTripPotentialTrips = async (tripId: string, tripUserId: string, tripData: PrimaryTripDetails, {paid=false, proper_match=false, trip_obstruction=false, seat_obstruction=false, reserving_trip_obstruction=false, mutual=false, group_largest_pickup_overlap_gap = null as number | null, group_largest_destination_overlap_gap = null as number | null, unknown_trip_obstruction=false}): Promise<void> => {
            const oldTripDocRef = db
                .collection(`users/${tripUserId}/trips`)
                .doc(tripId);
            await oldTripDocRef
                .update({
                    potential_trips: arrayUnion({
                        ...tripData,
                        paid,
                        proper_match,
                        trip_obstruction,
                        seat_obstruction,
                        reserving_trip_obstruction,
                        mutual,
                        group_largest_pickup_overlap_gap,
                        group_largest_destination_overlap_gap,
                        unknown_trip_obstruction,
                    }),
                });
        };

        const updateNewTripMatchedTrips = async (tripData: PrimaryTripDetails, {paid=false, mutual=false, reserving=false}): Promise<void> => {
            await newTripDocRef.update({
                matched_trips: arrayUnion({
                    trip_id: tripData.trip_id,
                    user_id: tripData.user_id,
                    trip_group_id: tripData.trip_group_id,
                    paid,
                    pickup_radius: tripData.pickup_radius,
                    destination_radius: tripData.destination_radius,
                    pickup_distance: tripData.pickup_distance,
                    destination_distance: tripData.destination_distance,
                    mutual,
                    reserving,
                    seat_count: tripData.total_seat_count,
                }),
            });
        };

        const updateOldTripMatchedTrips = async (tripId: string, tripUserId: string, tripData: PrimaryTripDetails, {paid=false, mutual=false, reserving=false}): Promise<void> => {
            const oldTripDocRef = db
                .collection(`users/${tripUserId}/trips`)
                .doc(tripId);
            await oldTripDocRef
                .update({
                    matched_trips: arrayUnion({
                        trip_id: tripData.trip_id,
                        user_id: userId,
                        trip_group_id: tripData.trip_group_id,
                        paid,
                        pickup_radius: tripData.pickup_radius,
                        destination_radius: tripData.destination_radius,
                        pickup_distance: tripData.pickup_distance,
                        destination_distance: tripData.destination_distance,
                        mutual,
                        reserving,
                        seat_count: tripData.total_seat_count,
                    }),
                });
        };

        const checkRemaningSeats = (oldTripGroupData: TripGroup, newTripData: Trip): boolean => {
            const remainingSeats = 4 - oldTripGroupData.total_seat_count;
            if (remainingSeats >= newTripData.seat_count) {
                return true;
            } else {
                return false;
            }
        };

        const calculateOverlapGap = (oldTripGroupData: TripGroup): [number, number] => {
            const obstructingTripMembers: ObstructingTripMember[] = [];
            const pickupOverlapGaps = [];
            const destinationOverlapGaps = [];

            for (const member of oldTripGroupData.potential_trip_members) {
                const obstructingTrip = member.obstructing_trip_members.filter(
                    (obstructingTrip) => obstructingTrip.unknown === false,
                );
                obstructingTripMembers.push(...obstructingTrip);
            }

            for (const obstructingTrip of obstructingTripMembers) {
                pickupOverlapGaps.push(obstructingTrip.pickup_overlap_gap > 0 ? obstructingTrip.pickup_overlap_gap : "N/A");
                destinationOverlapGaps.push(obstructingTrip.destination_overlap_gap > 0 ? obstructingTrip.destination_overlap_gap : "N/A");
              }
            const filteredPickupOverlapGap = pickupOverlapGaps.filter((gap) => gap !== "N/A") as number[];
            const filteredDestinationOverlapGap = destinationOverlapGaps.filter((gap) => gap !== "N/A") as number[];
            const largestPickupOverlapGap = Math.max(...filteredPickupOverlapGap);
            const largestDestinationOverlapGap = Math.max(...filteredDestinationOverlapGap);
            return [largestPickupOverlapGap, largestDestinationOverlapGap];
        };

        const generateObstructingTripMembersFromGroup = async (oldTripGroupData: TripGroup) => {
            const groupMembers = oldTripGroupData.trip_group_members.map((member) => ({
                trip_id: member.trip_id,
                user_id: member.user_id,
            }));

            const obstructingMembers = await Promise.all(groupMembers.map(async (member) => {
                const mtIndex = matchedTrips.findIndex((mt) => mt.trip_id === member.trip_id);
                const mt = mtIndex !== -1 ? matchedTrips[mtIndex] : null;
                
                const pD = mt ? pickupDistance[mtIndex] : null;
                const dD = mt ? destinationDistance[mtIndex] : null;
                const tripDoc = await db
                .collection(`users/${member.user_id}/trips`)
                .doc(member.trip_id).get();
                const trip = tripDoc.data() as Trip;
                if (!isProperMatch(trip, newTripData, pD?.distance ?? null, dD?.distance ?? null)) {
                    return {
                        trip_id: trip.trip_id,
                        pickup_overlap_gap: pD?.distance !== undefined ? 150 - (newTripData.pickup_radius + trip.pickup_radius - pD.distance) : null,
                        destination_overlap_gap: dD?.distance !== undefined ? 150 - (newTripData.destination_radius + trip.destination_radius - dD.distance): null,
                        unknown: mt ? false : true,
                    };
                }
                return null;
            }));
            return obstructingMembers.filter(Boolean);
        };

        const checkOldTripGroupPotentialTrips = async (oldTripGroupData: TripGroup, oldTripGroupDocRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>, {fully_matched = false} = {}) => {
            const isTripIdInPotentialTrips = oldTripGroupData.potential_trip_members.some((trip) => trip.trip_id === tripId);


            if (isTripIdInPotentialTrips) {
                return true;
            } else {
                const obstructingTripMembers = await generateObstructingTripMembersFromGroup(oldTripGroupData);
                await oldTripGroupDocRef
                .update({
                    potential_trip_members: arrayUnion({
                        trip_id: tripId,
                        seat_obstruction: fully_matched ? false : checkRemaningSeats(oldTripGroupData, newTripData),
                        trip_obstruction: fully_matched ? false : isProperMatchWithTripGroupMembers(oldTripGroupData, newTripData),
                        obstructing_trip_members: fully_matched ? null : obstructingTripMembers,
                        unknown_trip_obstruction: fully_matched? false : obstructingTripMembers.some((member) => member?.unknown === true),
                        seat_count: newTripData.seat_count,
                    }),
                });
                return true;
            }
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

          console.log("Starting First Stage Matching");

          const userTripPromises = usersSnapshot.docs.map(async (userDoc) => {
            const otherUserId = userDoc.id;

            if (otherUserId !== userId) {
              const tripsRef = db
                  .collection(`users/${otherUserId}/trips`);
              const queries = [];

              if (newTripData.is_time_fixed === false) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("is_time_fixed", "==", false)
                    .where("time_range_array", "array-contains-any",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.is_time_fixed === true) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("is_time_fixed", "==", false)
                    .where("time_range_array", "array-contains-any",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.is_time_fixed === false) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("is_time_fixed", "==", true)
                    .where("time_range_array", "array-contains-any",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }

              if (newTripData.is_time_fixed === true) {
                queries.push(tripsRef
                    .where("pickup_city", "==", newTripData.pickup_city)
                    .where("destination_city", "==",
                        newTripData.destination_city)
                    .where("is_time_fixed", "==", true)
                    .where("time_range_array", "array-contains-any",
                        newTripData.time_range_array)
                    .where("fully_matched", "==", false));
              }
              // Execute the queries
              const snapshots = await Promise
                  .all(queries.map((query) => query.get()));

              // Merge the results
              const filteredTripsSnapshot = snapshots
                  .flatMap((snapshot) => snapshot.docs);

              for (const doc of filteredTripsSnapshot) {
                const oldTripData = doc.data() as Trip;
                firstStageTrips.push(oldTripData);
              }
            }
          });
          await Promise.all(userTripPromises);

          // Check if there are any trips to match and update pickupMatches
          if (firstStageTrips.length > 0) {
            console.log("Trips have been gotten from the City/Time filter");
            pickupMatches = [];
            pickupDistance = [];
            if (firstStageTrips.length > 625) {
                nextBatch = [];

                for (let i = 0; i < firstStageTrips.length; i++) {
                  nextBatch.push(firstStageTrips[i]);
                  if (nextBatch.length === 625) {
                    for (let i = 0; i < nextBatch.length; i++) {
                        const oldTrip = nextBatch[i];
                        const origin = `${newTripData.pickup_latlng.lat},${newTripData.pickup_latlng.lng}`;
                        const destination = `${oldTrip.pickup_latlng.lat},${oldTrip.pickup_latlng.lng}`;
                        console.log("Making request with origins:", origin, "destinations:", destination);

                        const distanceMatrix = await getDistanceMatrix(origin, destination);
                        const distance = distanceMatrix.matrix[0][0].distance.value;


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
                    console.log("Making request with origins:", origin, "destinations:", destination);

                    const distanceMatrix = await getDistanceMatrix(origin, destination);
                    const distance = distanceMatrix.matrix[0][0].distance.value;

                    if (distance <= 10000) {
                        pickupMatches.push(oldTrip);
                        pickupDistance.push({distance: distance});
                    }
                }
                nextBatch = [];
            } else {
                for (let i = 0; i < firstStageTrips.length; i++) {
                    const oldTrip = firstStageTrips[i];
                    const origin = `${newTripData.pickup_latlng.lat},${newTripData.pickup_latlng.lng}`;
                    const destination = `${oldTrip.pickup_latlng.lat},${oldTrip.pickup_latlng.lng}`;

                    console.log("Making request with origins:", origin, "destinations:", destination);

                    const distanceMatrix = await getDistanceMatrix(origin, destination);
                    const distance = distanceMatrix.matrix[0][0].distance.value;

                    if (distance <= 9850) {
                        pickupMatches.push(oldTrip);
                        pickupDistance.push({distance: distance});
                    }
                }
            }
            } else {
                await setNewTripStatus("unmatched");
                throw new Error("No trips gotten from the City/Time filter");
            }

            // Check if there are any trips to match with the pickupMatches and update matchedTrips
            if (pickupMatches.length > 0) {
                console.log("Trips have been gotten from the Distance Matrix using the Pickup Latlng");
                matchedTrips = [];
                destinationDistance = [];
                if (pickupMatches.length > 625) {
                    nextBatch = [];

                    for (let i = 0; i < pickupMatches.length; i++) {
                        nextBatch.push(pickupMatches[i]);
                        if (nextBatch.length === 625) {
                            for (let i = 0; i < nextBatch.length; i++) {
                                const oldTrip = nextBatch[i];
                                const origin = `${newTripData.destination_latlng.lat},${newTripData.destination_latlng.lng}`;
                                const destination = `${oldTrip.destination_latlng.lat},${oldTrip.destination_latlng.lng}`;
                                console.log("Making request with origins:", origin, "destinations:", destination);

                                const distanceMatrix = await getDistanceMatrix(origin, destination);
                                const distance = distanceMatrix.matrix[0][0].distance.value;

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
                        console.log("Making request with origins:", origin, "destinations:", destination);

                        const distanceMatrix = await getDistanceMatrix(origin, destination);
                        const distance = distanceMatrix.matrix[0][0].distance.value;

                        if (distance <= 10000) {
                            matchedTrips.push(oldTrip);
                            destinationDistance.push({distance: distance});
                        }
                    }
                    nextBatch = [];
                } else {
                    for (let i = 0; i < pickupMatches.length; i++) {
                        const oldTrip = pickupMatches[i];
                        const origin = `${newTripData.destination_latlng.lat},${newTripData.destination_latlng.lng}`;
                        const destination = `${oldTrip.destination_latlng.lat},${oldTrip.destination_latlng.lng}`;
                        console.log("Making request with origins:", origin, "destinations:", destination);

                        const distanceMatrix = await getDistanceMatrix(origin, destination);
                        const distance = distanceMatrix.matrix[0][0].distance.value;

                        if (distance <= 9850) {
                            matchedTrips.push(oldTrip);
                            destinationDistance.push({distance: distance});
                        }
                    }
                }
            } else {
                await setNewTripStatus("unmatched");
                throw new Error("No trips gotten from the Distance Matrix using the Pickup Latlng");
            }
        } catch (error) {
          console.error(error);
          throw new Error("Trip could not match at the first stage (City and Time Filter) / Distance Matrix");
        }

        try {
            if (matchedTrips.length > 0) {
                console.log(matchedTrips.length, "Trips have been gotten from the Distance Matrix using the Destination Latlng");
                console.log("Starting Second Stage Matching");
                const potentialTrips = matchedTrips.map((trip, index) => {
                    return {
                        trip_id: trip.trip_id,
                        user_id: trip.user_id,
                        trip_group_id: trip.trip_group_id,
                        pickup_radius: trip.pickup_radius,
                        destination_radius: trip.destination_radius,
                        pickup_distance: pickupDistance[index].distance,
                        destination_distance: destinationDistance[index].distance,
                        total_seat_count: trip.total_seat_count,
                    };
                });

                for (const [index, trip] of matchedTrips.entries()) {
                    potentialNewTrip = {
                        trip_id: tripId,
                        user_id: userId,
                        trip_group_id: newTripData.trip_group_id,
                        pickup_radius: newTripData.pickup_radius,
                        destination_radius: newTripData.destination_radius,
                        pickup_distance: pickupDistance[index].distance,
                        destination_distance: pickupDistance[index].distance,
                        total_seat_count: newTripData.total_seat_count,
                    };
                    if (trip.status === "matched" || trip.status === "unmatched" ) {
                        if (isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance) && trip.reserved === false) {
                            console.log("Trip is a proper match and not reserved");
                            await setOldTripStatus(trip.trip_id, trip.user_id, "matched");

                            await setNewTripStatus("matched");

                            await updateNewTripMatchedTrips(potentialTrips[index], {paid: false, reserving: false, mutual: true});

                            await updateOldTripMatchedTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, reserving: false, mutual: true});
                        } else if (isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance) && trip.reserved === true) {
                            console.log("Trip is a proper match and reserved");
                            const oldTrip = await getOldTripData(trip.reserving_trip_id, trip.reserving_trip_user_id);
                            const mtIndex = matchedTrips.findIndex((mt) => mt.trip_id === trip.reserving_trip_id);
                            const mt = mtIndex !== -1 ? matchedTrips[mtIndex] : null;
                            
                            const pD = mt ? pickupDistance[mtIndex] : null;
                            const dD = mt ? destinationDistance[mtIndex] : null;
                            if (oldTrip && isProperMatch(oldTrip[0], newTripData, pD?.distance ?? null, dD?.distance ?? null)) {
                                await updateNewTripMatchedTrips(potentialTrips[index], {paid: false, reserving: false, mutual: true});

                                await updateOldTripMatchedTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, reserving: false, mutual: true});

                                await setOldTripStatus(trip.trip_id, trip.user_id, "matched");

                                await setNewTripStatus("matched");
                            } else {
                                await updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: true, trip_obstruction: false, seat_obstruction: false, reserving_trip_obstruction: true, mutual: false});

                                await updateOldTripMatchedTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, reserving: false, mutual: false});
                            }
                        } else if (!isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance) && trip.reserved === false) {
                            console.log("Trip is not a proper match and not reserved");
                            await updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserving_trip_obstruction: false, mutual: true});

                            await updateOldTripPotentialTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, proper_match: false, reserving_trip_obstruction: false, trip_obstruction: false, seat_obstruction: false, mutual: true});
                        } else if (!isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance) && trip.reserved === true) {
                            console.log("Trip is not a proper match and reserved");
                            const oldTrip = await getOldTripData(trip.reserving_trip_id, trip.reserving_trip_user_id);
                            const mtIndex = matchedTrips.findIndex((mt) => mt.trip_id === trip.reserving_trip_id);
                            const mt = mtIndex !== -1 ? matchedTrips[mtIndex] : null;
                            
                            const pD = mt ? pickupDistance[mtIndex] : null;
                            const dD = mt ? destinationDistance[mtIndex] : null;
                            if (oldTrip && isProperMatch(oldTrip[0], newTripData, pD?.distance ?? null, dD?.distance ?? null)) {
                                await updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserving_trip_obstruction: false, mutual: true});
                            } else {
                                await updateNewTripPotentialTrips(potentialTrips[index], {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserving_trip_obstruction: true, mutual: true});
                            }
                            await updateOldTripPotentialTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, mutual: true});
                        }
                    } else if (trip.status === "paid") {
                        const oldTripGroupDocRef = db
                            .collection(`users/${trip.user_id}/trip_groups`)
                            .doc(trip.trip_id);
                        const oldTripGroupDoc = await oldTripGroupDocRef.get();
                        const oldTripGroupData = oldTripGroupDoc.data() as TripGroup;
                        if (isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance) &&
                            await isProperMatchWithTripGroupMembers(oldTripGroupData, newTripData) &&
                            checkRemaningSeats(oldTripGroupData, newTripData)) {
                            if (await checkOldTripGroupPotentialTrips(oldTripGroupData, oldTripGroupDocRef, {fully_matched: true})) {
                                await updateOldTripMatchedTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, reserving: false, mutual: false});

                                await updateNewTripMatchedTrips(potentialTrips[index], {paid: true, reserving: false, mutual: true});
                                await setNewTripStatus("matched");
                            }
                        } else {
                            if (await checkOldTripGroupPotentialTrips(oldTripGroupData, oldTripGroupDocRef)) {
                                const oldTripGroupDoc = await oldTripGroupDocRef.get();
                                const oldTripGroupData = oldTripGroupDoc.data() as TripGroup;
                                const largestOvelapGap = calculateOverlapGap(oldTripGroupData);
                                const obstructingMembers = await generateObstructingTripMembersFromGroup(oldTripGroupData);
                                const isUnknown = obstructingMembers.some((member) => member?.unknown === true);
                                if (isProperMatch(trip, newTripData, pickupDistance[index].distance, destinationDistance[index].distance)) {
                                    const tripObstruction = await isProperMatchWithTripGroupMembers(oldTripGroupData, newTripData);
                                    const seatObstruction = checkRemaningSeats(oldTripGroupData, newTripData);

                                    await updateNewTripPotentialTrips(potentialTrips[index], {paid: true, proper_match: true, trip_obstruction: tripObstruction, seat_obstruction: seatObstruction, reserving_trip_obstruction: false, mutual: false,
                                    group_largest_pickup_overlap_gap: largestOvelapGap[0],
                                    group_largest_destination_overlap_gap: largestOvelapGap[1],
                                    unknown_trip_obstruction: isUnknown,
                                    });

                                    await updateOldTripMatchedTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, reserving: false, mutual: true});
                                } else {
                                    await updateNewTripPotentialTrips(potentialTrips[index], {paid: true, proper_match: false, trip_obstruction: true, seat_obstruction: checkRemaningSeats(oldTripGroupData, newTripData), reserving_trip_obstruction: false, mutual: true,
                                    group_largest_pickup_overlap_gap: largestOvelapGap[0],
                                    group_largest_destination_overlap_gap: largestOvelapGap[1],
                                    unknown_trip_obstruction: isUnknown,
                                    });

                                    await updateOldTripPotentialTrips(trip.trip_id, trip.user_id, potentialNewTrip, {paid: false, proper_match: false, trip_obstruction: false, seat_obstruction: false, reserving_trip_obstruction: false, mutual: true,
                                    group_largest_pickup_overlap_gap: null,
                                    group_largest_destination_overlap_gap: null,
                                    unknown_trip_obstruction: isUnknown,
                                    });
                                }
                            }
                        }
                    }
                }
                if (isNewTripMatched === false) {
                    throw new Error("No trips matched at the second stage (Matched/Potential Trips Logic)");
                } else {
                    console.log("Trips have been matched successfully");
                    return null;
                }
            } else {
                await setNewTripStatus("unmatched");
                throw new Error("No trips gotten from the Distance Matrix using the Destination Latlng");
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
