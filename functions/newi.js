// /* eslint-disable no-constant-condition */
// /* eslint-disable camelcase */

// /**
//  * Import function triggers from their respective submodules:
//  *
//  * const {onCall} = require("firebase-functions/v2/https");
//  * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
//  *
//  * See a full list of supported triggers at https://firebase.google.com/docs/functions
//  */

// // The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
// const {onDocumentCreated} = require("firebase-functions/v2/firestore");

// // The Firebase Admin SDK to access Firestore.
// const {initializeApp} = require("firebase-admin/app");
// const {getFirestore} = require("firebase-admin/firestore");
// const db = getFirestore();


// initializeApp();

// db.settings({ignoreUndefinedProperties: true});


// exports.matchingFunction = onDocumentCreated("users/{userId}/trips/{tripId}",
//     async (event) => {
//       try {
//         const userId = event.params.userId;
//         const tripId = event.params.tripId;
//         const snapshot = event.data;
//         if (!snapshot) {
//           console.log("No data associated with the event");
//           return;
//         }
//         const newTripData = snapshot.data();
//         console.log(newTripData);
//         console.log(typeof newTripData.start_date_time);
//         const firstStageTrips = [];
//         let secondStageTrips = [];
//         let thirdStageTrips = [];
//         const fourthStageTrips = [];
//         const finalStageTrips = [];

//         const matchedTrips = [];
//         const newMatchedTripData = [];
//         // const poolRef = db.collection("pools");
//         const apiKey = process.env.API_KEY;
//         const distanceMatrixApiKey = process.env.DISTANCE_MATRIX_API_KEY;

//         const matchCheck = async (list) => {
//           if (list.length > 0) {
//             const userTripDocRef = db
//                 .collection(`users/${userId}/trips`).doc(tripId);
//             await userTripDocRef.update({status: "matched"});

//             return "matched";
//           } else {
//             const userTripDocRef = db
//                 .collection(`users/${userId}/trips`).doc(tripId);
//             await userTripDocRef.update({status: "unmatched"});
//             return "no";
//           }
//         };

//         const isProperMatch = (matchedtrip, newTripData) => {
//           return (
//             newTripData.pickup_radius + matchedtrip.pickup_radius <=
//             matchedtrip.pickup_distance &&
//             // eslint-disable-next-line max-len
//             newTripData.destination_radius + matchedtrip.destination_radius <= matchedtrip.destination_distance
//           );
//         };

//         // const isFullyMatched = (newTripMatches, oldTripGroup) => {
//         //   const newTripMatchIds = newTripMatches.map((trip) => trip.trip_id);
//         //   const oldTripGroupIds = oldTripGroup.map((trip) => trip.trip_id);
//         //   return newTripMatchIds.length ===
//         //   oldTripGroupIds.length && newTripMatchIds
//         //       .every((value) => oldTripGroupIds.includes(value));
//         // };

//         try {
//           // Retrieve all users
//           const usersSnapshot = await db.collection("users").get();

//           const userTripPromises = usersSnapshot.docs.map(async (userDoc) => {
//             const otherUserId = userDoc.id;

//             if (otherUserId !== userId) {
//               const tripsRef = db
//                   .collection(`users/${otherUserId}/trips`);
//               const queries = [];

//               if (newTripData.isTripTimeFixed === false) {
//                 queries.push(tripsRef
//                     .where("pickup_city", "==", newTripData.pickup_city)
//                     .where("destination_city", "==",
//                         newTripData.destination_city)
//                     .where("isTripTimeFixed", "==", false)
//                     .where("time_range_array", "array-contains-any",
//                         newTripData.time_range_array)
//                     .where("fully_matched", "==", false));
//               }

//               if (newTripData.isTripTimeFixed === true) {
//                 queries.push(tripsRef
//                     .where("pickup_city", "==", newTripData.pickup_city)
//                     .where("destination_city", "==",
//                         newTripData.destination_city)
//                     .where("isTripTimeFixed", "==", false)
//                     .where("time_range_array", "array-contains",
//                         newTripData.start_date_string)
//                     .where("fully_matched", "==", false));
//               }

//               if (newTripData.isTripTimeFixed === false) {
//                 queries.push(tripsRef
//                     .where("pickup_city", "==", newTripData.pickup_city)
//                     .where("destination_city", "==",
//                         newTripData.destination_city)
//                     .where("isTripTimeFixed", "==", true)
//                     .where("start_date_string", "in",
//                         newTripData.time_range_array)
//                     .where("fully_matched", "==", false));
//               }

//               if (newTripData.isTripTimeFixed === true) {
//                 queries.push(tripsRef
//                     .where("pickup_city", "==", newTripData.pickup_city)
//                     .where("destination_city", "==",
//                         newTripData.destination_city)
//                     .where("isTripTimeFixed", "==", true)
//                     .where("start_date_string", "==",
//                         newTripData.start_date_string)
//                     .where("fully_matched", "==", false));
//               }
//               // Execute the queries
//               const snapshots = await Promise
//                   .all(queries.map((query) => query.get()));

//               // Merge the results
//               const filteredTripsSnapshot = snapshots
//                   .flatMap((snapshot) => snapshot.docs);

//               filteredTripsSnapshot.forEach((doc) => {
//                 const oldTripData = doc.data();
//                 firstStageTrips.push(oldTripData);
//               });
//             }
//           });
//           await Promise.all(userTripPromises);
//           if (await (matchCheck(firstStageTrips)) == "no") {
//             throw new Error("Empty Array Returned");
//           } else console.log("First stage of matched trips:", firstStageTrips);
//         } catch (error) {
//           console.error("Error fetching users or trips:", error);
//           // eslint-disable-next-line max-len
//           throw new Error("Trip could not match at the first stage (City and Time Filter)");
//         }

//         const requests = firstStageTrips.map((trip) => {
//           const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${trip.pickup_description}&strictbounds=True&location=${newTripData.pickup_latlng.latitude},${newTripData.pickup_latlng.longitude}&radius=${newTripData.pickup_radius*2}&key=${apiKey}`;
//           return fetch(url)
//               .then((response) => {
//                 if (!response.ok) {
//                   throw new Error("Network response was not ok");
//                 }
//                 return response.json();
//               })
//               .then((data) => {
//                 if (!data) {
//                   console.log("No data gotten");
//                 }

//                 return {trip, data};
//               })
//               .catch((error) => {
//                 console.error("There was a problem with the request:", error);
//               });
//         });
//         try {
//           const results = await Promise.all(requests);
//           const filteredTrips = results.filter((result) => {
//             const data = result.data;
//             if (data.status === "OK" && data.predictions.length > 0) {
//               // Check if any place description matches the innput parameter
//               const descriptions = data.predictions
//                   .map((prediction) => prediction.description);
//               return descriptions.some((description) => {
//                 return description.toLowerCase()
//                     .includes(result.trip.pickup_description.toLowerCase());
//               });
//             }
//             // If no predictions or status is not "OK", exclude this trip
//             return false;
//           });
//           secondStageTrips = filteredTrips
//               .map((filtered) => filtered.trip);
//           if (await (matchCheck(secondStageTrips)) == "no") {
//             throw new Error("Empty array returned on second stage");
//           } else {
//             console.log("Second Stage of matched Trips (Pickups):",
//                 secondStageTrips);
//           }
//         } catch (error) {
//           console.error("Error in processing requests:", error);
//           // eslint-disable-next-line max-len
//           throw new Error("Trip could not match at the second stage (Place AutoComplete with Pickup)");
//         }

//         const destinationRequests = secondStageTrips.map((trip) => {
//           const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${trip.destination_description}&strictbounds=True&location=${newTripData.destination_latlng.latitude},${newTripData.destination_latlng.longitude}&radius=${newTripData.destination_radius*2}&key=${apiKey}`;
//           return fetch(url)
//               .then((response) => {
//                 if (!response.ok) {
//                   throw new Error("Network response was not ok");
//                 }
//                 return response.json();
//               })
//               .then((data) => {
//                 return {trip, data};
//               })
//               .catch((error) => {
//                 console.error("There was a problem with the request:", error);
//               });
//         });
//         try {
//           const results = await Promise.all(destinationRequests);
//           const filteredTrips = results.filter((result) => {
//             const data = result.data;
//             if (data.status === "OK" && data.predictions.length > 0) {
//               // Check if any place description matches the input parameter
//               const descriptions = data.predictions
//                   .map((prediction) => prediction.description);
//               return descriptions.some((description) => {
//                 return description.toLowerCase()
//                     .includes(result.trip.destination_description
//                         .toLowerCase());
//               });
//             }
//             // If no predictions or status is not "OK", exclude this trip
//             return false;
//           });
//           thirdStageTrips = filteredTrips
//               .map((filtered) => filtered.trip);
//           if (await (matchCheck(thirdStageTrips)) == "no") {
//             throw new Error("Empty array returned on third stage");
//           } else {
//             console.log("Third stage of Matched Trips (destinations):",
//                 thirdStageTrips);
//           }
//         } catch (error) {
//           console.error("Error in processing requests:", error);
//           // eslint-disable-next-line max-len
//           throw new Error("Trip could not match at the third stage (Place AutoComplete with Destination)");
//         }

//         const distanceMatrixApiUrl = "https://api.distancematrix.ai/maps/api/distancematrix/json";

//         const origins = newTripData.pickup_description;
//         const destinations = thirdStageTrips
//             .map((trip) => trip.pickup_description).join("|");

//         // eslint-disable-next-line max-len
//         const distanceMatrixUrl = `${distanceMatrixApiUrl}?origins=${origins}&destinations=${destinations}&key=${distanceMatrixApiKey}`;

//         try {
//           const distanceMatrixResponse = await fetch(distanceMatrixUrl);
//           if (!distanceMatrixResponse.ok) {
//             throw new Error("DistanceMatrix API request failed");
//           }
//           const distanceMatrixData = await distanceMatrixResponse.json();
//           if (distanceMatrixData.status === "OK") {
//             const rows = distanceMatrixData.rows;
//             if (rows.length > 0 && rows[0].elements.length > 0) {
//               rows[0].elements.forEach((element, index) => {
//                 if (element.distance && element.distance.value !== undefined) {
//                   const distanceValue = element.distance.value;
//                   if (distanceValue <= newTripData.pickup_radius*2) {
//                     const tripToAdd = thirdStageTrips[index];
//                     tripToAdd.pickup_distance = distanceValue;
//                     fourthStageTrips
//                         .push(tripToAdd);
//                   }
//                 } else {
//                   // eslint-disable-next-line max-len
//                   console.log("Distance value is undefined for this trip:", thirdStageTrips[index]);
//                   const tripToAdd = thirdStageTrips[index];
//                   tripToAdd.pickup_distance = 0;
//                   fourthStageTrips.push(tripToAdd);
//                 }
//               });
//             }
//           }
//           if (await (matchCheck(fourthStageTrips)) == "yes") {
//             throw new Error("Empty Array returned at fouth stage");
//           } else {
//             console.log("Fourth stage of Matched Trips (pickups):",
//                 fourthStageTrips);
//           }
//         } catch (error) {
//           console.error("Error fetching distance matrix:", error);
//           // eslint-disable-next-line max-len
//           throw new Error("Trip could not match at the fourth stage (Distance Matrix with Pickup)");
//         }


//         const finalOrigins = newTripData.destination_description;
//         const finalDestinations = fourthStageTrips
//             .map((trip) => trip.destination_description).join("|");

//         // eslint-disable-next-line max-len
//         const finalDistanceMatrixUrl = `${distanceMatrixApiUrl}?origins=${finalOrigins}&destinations=${finalDestinations}&key=${distanceMatrixApiKey}`;

//         try {
//           const distanceMatrixResponse = await fetch(finalDistanceMatrixUrl);
//           if (!distanceMatrixResponse.ok) {
//             throw new Error("DistanceMatrix API request failed");
//           }
//           const distanceMatrixData = await distanceMatrixResponse.json();
//           if (distanceMatrixData.status === "OK") {
//             const rows = distanceMatrixData.rows;
//             if (rows.length > 0 && rows[0].elements.length > 0) {
//               rows[0].elements.forEach((element, index) => {
//                 if (element.distance && element.distance.value !== undefined) {
//                   const distanceValue = element.distance.value;
//                   if (distanceValue <= newTripData.destination_radius*2) {
//                     const tripToAdd = fourthStageTrips[index];
//                     tripToAdd.destination_distance = distanceValue;
//                     tripToAdd.reserved = false;
//                     finalStageTrips
//                         .push(tripToAdd);
//                   }
//                 } else {
//                   // eslint-disable-next-line max-len
//                   console.log("Distance value is undefined for this trip:", thirdStageTrips[index]);
//                   const tripToAdd = fourthStageTrips[index];
//                   tripToAdd.destination_distance = 0;
//                   tripToAdd.reserved = false;
//                   finalStageTrips.push(tripToAdd);
//                 }
//               });
//             }
//           }
//           if (await (matchCheck(finalStageTrips)) == "no") {
//             throw new Error("Empty array returned at fifth stage");
//           } else {
//             matchedTrips
//                 .push(finalStageTrips
//                     .map(({trip_id, pickup_radius, destination_radius,
//                       pickup_distance, destination_distance}) => ({
//                       trip_id,
//                       pickup_radius,
//                       destination_radius,
//                       pickup_distance,
//                       destination_distance,
//                     })));
//             const {trip_id, pickup_radius, destination_radius} = newTripData;
//             newMatchedTripData.push(
//                 matchedTrips.map(({pickup_distance, destination_distance}) => ({
//                   trip_id,
//                   pickup_radius,
//                   destination_radius,
//                   pickup_distance,
//                   destination_distance,
//                   reserved: false,
//                 })));

//             console.log("Fifth stage of Matched Trips (destinations):",
//                 finalStageTrips);
//           }
//         } catch (error) {
//           console.error("Error fetching distance matrix:", error);
//           // eslint-disable-next-line max-len
//           throw new Error("Trip could not match at the fifth stage (Distance Matrix with Destination)");
//         }

//         // const processTrips = async () => {
//         //   const processPromises = finalStageTrips.map(async (trip) => {
//         //     const poolQuery = await poolRef
//         //         .where("trips", "array-contains", trip).get();
//         //     if (!poolQuery.empty) {
//         //       // Trip found in a pool, update existing pools
//         //       const updatePoolPromises = poolQuery.docs
//         //           .map(async (docSnapshot) => {
//         //             const docData = docSnapshot.data();
//         //             const existingTrips = docData.trips;
//         //             // eslint-disable-next-line max-len
//         //             if (existingTrips.every((trip) => finalStageTrips
//         //                .includes(trip))) {
//         //               const newTrips = [...existingTrips, newTripData];
//         //               await docSnapshot.ref.update({trips: newTrips});
//         //             } else {
//         //               await poolRef.add({
//         //                 trips: [trip, tripId],
//         //               });
//         //             }
//         //           });
//         //       await Promise.all(updatePoolPromises);
//         //     } else {
//         //       // Trip not found in any pool, create new pool
//         //       await poolRef.add({
//         //         trips: [trip.uid, newTripData],
//         //       });
//         //     }
//         //   });
//         //   await Promise.all(processPromises);
//         // };
//         // await processTrips();

//         for (let i = 0; i < finalStageTrips.length; i++) {
//           const currentTrip = finalStageTrips[i];
//           const oldTripGroup = {};

//           // Check if trip_status is matched or unmatched
//           if (currentTrip.trip_status === "matched" ||
//             currentTrip.trip_status === "unmatched") {
//             const result = isProperMatch(currentTrip, newTripData);
//             if (result == true && currentTrip.reserved == false) {
//               if (currentTrip.trip_status == "unmatched" ||
//               currentTrip.trip_status == "matched");
//               {
//                 currentTrip.trip_status = "matched";
//                 const userTripDocRef = db
//                     .collection(`users/${userId}/trips`).doc(tripId);
//                 currentTrip.trip_status = "unmatched" ? await userTripDocRef
//                     .update({matched_trips: db.FieldValue
//                         .arrayUnion({...matchedTrips[i], paid: false,
//                           priority: true, mutual: true})}) :
//                     await userTripDocRef
//                         .update({matched_trips: db.FieldValue
//                             .arrayUnion({...matchedTrips[i], paid: false,
//                               priority: false, mutual: true})});
//                 const tripRef = db
//                     .collectionGroup("trips")
//                     .doc(currentTrip.trip_id);
//                 tripRef.get().then(async (doc) => {
//                   if (doc.exists) {
//                     const userRef = doc.ref.parent.parent;
//                     const userId = userRef.id;
//                     const userTripDocRef = db
//                         .collection(`users/${userId}/trips`)
//                         .doc(currentTrip.trip_id);
//                     await userTripDocRef
//                         .update({matched_trips: db.FieldValue
//                             .arrayUnion({...newMatchedTripData[i], paid: false,
//                               mutual: true})});
//                   } else {
//                     console.log("No such document!");
//                   }
//                 }).catch((error) => {
//                   console.log("Error getting document:", error);
//                 });
//               }
//             } else {
//               if (result == true) {
//                 const userTripDocRef = db
//                     .collection(`users/${userId}/trips`).doc(tripId);
//                 await userTripDocRef
//                     .update({potential_trips: db.FieldValue
//                         .arrayUnion({...matchedTrips[i],
//                           paid: false, proper_match: true, reserved: true,
//                           trip_obstruction: false, seat_obstruction: false,
//                           mutual: false})});
//                 const tripRef = db
//                     .collectionGroup("trips").doc(currentTrip.trip_id);
//                 tripRef.get().then(async (doc) => {
//                   if (doc.exists) {
//                     const userRef = doc.ref.parent.parent;
//                     const userId = userRef.id;
//                     const userTripDocRef = db
//                         .collection(`users/${userId}/trips`)
//                         .doc(currentTrip.trip_id);
//                     await userTripDocRef
//                         .update({potential_trips: db.FieldValue
//                             .arrayUnion({...newMatchedTripData[i],
//                               paid: false, mutual: false})});
//                   } else {
//                     console.log("No such document!");
//                   }
//                 }).catch((error) => {
//                   console.log("Error getting document:", error);
//                 });
//               } else {
//                 if (currentTrip.reserved == "true") {
//                   const userTripDocRef = db
//                       .collection(`users/${userId}/trips`).doc(tripId);
//                   await userTripDocRef
//                       .update({potential_trips: db.FieldValue
//                           .arrayUnion({...matchedTrips[i],
//                             paid: false, proper_match: false, reserved: true,
//                             trip_obstruction: false, seat_obstruction: false,
//                             mutual: true})});
//                   const tripRef = db
//                       .collectionGroup("trips").doc(currentTrip.trip_id);
//                   tripRef.get().then(async (doc) => {
//                     if (doc.exists) {
//                       const userRef = doc.ref.parent.parent;
//                       const userId = userRef.id;
//                       const userTripDocRef = db
//                           .collection(`users/${userId}/trips`)
//                           .doc(currentTrip.trip_id);
//                       await userTripDocRef
//                           .update({potential_trips: db.FieldValue
//                               .arrayUnion({...newMatchedTripData[i],
//                                 paid: false, proper_match: false,
//                                 reserved: false,
//                                 trip_obstruction: false,
//                                 seat_obstruction: false,
//                                 mutual: true})});
//                     } else {
//                       console.log("No such document!");
//                     }
//                   }).catch((error) => {
//                     console.log("Error getting document:", error);
//                   });
//                 } else {
//                   const userTripDocRef = db
//                       .collection(`users/${userId}/trips`).doc(tripId);
//                   await userTripDocRef
//                       .update({potential_trips: db.FieldValue
//                           .arrayUnion({...matchedTrips[i],
//                             paid: false, proper_match: false,
//                             reserved: false,
//                             trip_obstruction: false,
//                             seat_obstruction: false,
//                             mutual: true})});
//                   const tripRef = db
//                       .collectionGroup("trips").doc(currentTrip.trip_id);
//                   tripRef.get().then(async (doc) => {
//                     if (doc.exists) {
//                       const userRef = doc.ref.parent.parent;
//                       const userId = userRef.id;
//                       const userTripDocRef = db
//                           .collection(`users/${userId}/trips`)
//                           .doc(currentTrip.trip_id);
//                       await userTripDocRef
//                           .update({potential_trips: db.FieldValue
//                               .arrayUnion({...newMatchedTripData[i],
//                                 paid: false, proper_match: false,
//                                 reserved: false,
//                                 trip_obstruction: false,
//                                 seat_obstruction: false,
//                                 mutual: true})});
//                     } else {
//                       console.log("No such document!");
//                     }
//                   }).catch((error) => {
//                     console.log("Error getting document:", error);
//                   });
//                 }
//               }
//             }
//           } else if (currentTrip.trip_status === "paid") {
//             if (isProperMatch(currentTrip, newTripData) &&
//             oldTripGroup.trip_group_members.every((member) => {
//               const matchedTrip = newTripData.matchedTrips
//                   .find((trip) => trip.trip_id === member.trip_id);
//               return matchedTrip && isProperMatch(newTripData, matchedTrip);
//             }) &&
//                   oldTripGroup.total_seat_count == 4 &&
//                   oldTripGroup.total_seat_count >= newTripData.seat_count) {
//               if (oldTripGroup.potential_trips
//                   .some((potential) => potential.trip_id ===
//                   newTripData.trip_id)) {
                    
//               }
//               oldTripGroup.matched_trips.push(newTripData.trip_id);
//               const userTripDocRef = db
//                   .collection(`users/${userId}/trips`).doc(tripId);
//               await userTripDocRef
//                   .update({matched_trips: db.FieldValue
//                       .arrayUnion({...matchedTrips[i], paid: true,
//                         trip_group_id: oldTripGroup.trip_group_id})});
//             }
//           }
//         }

//         console.log("Matching complete"); // Return a promise or null when done
//         return "Matching complete";
//       } catch (error) {
//         console.error("Function execution halted:", error);
//         return null;
//       }
//     });

//     const updateTripGroupMembersFromObstructedTrips = async (choiceTripGroupDocRef, newlyObstructedTrips, choiceTGMembers, tripGroupMembers) => {
//       const choiceTripGroupDoc = await choiceTripGroupDocRef.get();
//       const choiceTripGroupData = choiceTripGroupDoc.data();

//       tripGroupMembers.forEach(async (trip) => {
//           const [oldTripData, oldTripDocRef] = await getOldTripData(trip.trip_id, trip.user_id);

//           newlyObstructedTrips.forEach(async (obstructedTrip) => {
//               let updatedMatchedTrips = [...oldTripData.matched_trips];
//               let updatedPotentialTrips = [...oldTripData.potential_trips];
//               let tripUpdated = false;
//               updatedMatchedTrips = updatedMatchedTrips.map((matchedTrip) => {
//                   if (matchedTrip.trip_id === obstructedTrip.trip_id) {
//                       tripUpdated = true;
//                       return {...matchedTrip, mutual: !matchedTrip.mutual};
//                   }
//                   return matchedTrip;
//               });

//               if (!tripUpdated) {
//                   updatedPotentialTrips = updatedPotentialTrips.map((potentialTrip) => {
//                       if (potentialTrip.trip_id === obstructedTrip.trip_id) {
//                           tripUpdated = true;
//                           return {...potentialTrip, mutual: !potentialTrip.mutual};
//                       }
//                       return potentialTrip;
//                   });
//               }

//               if (tripUpdated) {
//                   await oldTripDocRef.update({
//                       matched_trips: updatedMatchedTrips,
//                       potential_trips: updatedPotentialTrips,
//                   });
//                   console.log(`Mutual property updated for trip ${obstructedTrip.trip_id}`);
//               } else {
//                   console.log(`No matching trip found for obstructedTrip ${obstructedTrip.trip_id}`);
//               }
//           });
//       });
//   };