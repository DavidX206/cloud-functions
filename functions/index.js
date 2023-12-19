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


initializeApp();


exports.matchingFunction = onDocumentCreated("users/{userId}/trips/{tripId}",
    async (event) => {
      try {
        const userId = event.params.userId;
        const tripId = event.params.tripId;
        const snapshot = event.data;
        if (!snapshot) {
          console.log("No data associated with the event");
          return;
        }
        const newTripData = snapshot.data();
        const matchingTrips = [];
        const pickupMatchingTrips = [];
        const destinationMatchingTrips = [];
        const finalPickupTrips = [];
        const finalTrips = [];
        const poolRef = getFirestore().collection("pools");
        const apiKey = process.env.API_KEY;
        const distanceMatrixApiKey = process.env.DISTANCE_MATRIX_API_KEY;

        const matchCheck = async (list) => {
          if (list.length > 0) {
            const userTripDocRef = getFirestore()
                .collection(`users/${userId}/trips`).doc(tripId);
            await userTripDocRef.update({status: "matched"});

            return "matched";
          } else {
            const userTripDocRef = getFirestore()
                .collection(`users/${userId}/trips`).doc(tripId);
            await userTripDocRef.update({status: "unmatched"});
            throw new Error("Trip could not be matched");
          }
        };

        try {
          // Retrieve all users
          const usersSnapshot = await getFirestore().collection("users").get();

          const userTripPromises = usersSnapshot.docs.map(async (userDoc) => {
            const otherUserId = userDoc.id;

            if (otherUserId !== userId) {
              const filteredTripsSnapshot = await getFirestore()
                  .collection(`users/${otherUserId}/trips`)
                  .where("pickup_city", "==", newTripData.pickup_city)
                  .where("destination_city", "==", newTripData.destination_city)
                  .where(newTripData.start_date_time, "<=", "start_date_time",
                      "<=", newTripData.end_date_time ||
                      newTripData.start_date_time, "<=", "end_date_time",
                      "<=", newTripData.end_date_time ||
                      "start_date_time", "<=", newTripData.start_date_time,
                      "<=", "end_date_time" ||
                      "start_date_time", "<=", newTripData.end_date_time,
                      "<=", "end_date_time" ||
                      "start_date_time", "===", newTripData.start_date_time)
                  .where("fully_matched", "==", "false")
                  .get();

              filteredTripsSnapshot.forEach((doc) => {
                const oldTripData = doc.data();
                matchingTrips.push(oldTripData);
              });
            }
          });
          await Promise.all(userTripPromises);
        } catch (error) {
          console.error("Error fetching users or trips:", error);
        }

        matchCheck(matchingTrips);


        const requests = matchingTrips.map((trip) => {
          const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${trip.pickup_description}&strictbounds=True&location=${newTripData.pickup_latlng}&radius=${newTripData.pickup_radius*2}&key=${apiKey}`;
          return fetch(url)
              .then((response) => {
                if (!response.ok) {
                  throw new Error("Network response was not ok");
                }
                return response.json();
              })
              .then((data) => {
                return {trip, data};
              })
              .catch((error) => {
                console.error("There was a problem with the request:", error);
              });
        });
        Promise.all(requests)
            .then((results) => {
              const filteredTrips = results.filter((result) => {
                const data = result.data;
                if (data.status === "OK" && data.predictions.length > 0) {
                  // Check if any place description matches the input parameter
                  const descriptions = data.predictions
                      .map((prediction) => prediction.description);
                  return descriptions.some((description) => {
                    return description.toLowerCase()
                        .includes(result.trip.pickup_description.toLowerCase());
                  });
                }
                // If no predictions or status is not "OK", exclude this trip
                return false;
              });
              const tripList = filteredTrips
                  .map((filtered) => filtered.trip);
              pickupMatchingTrips.push(tripList);
              console.log("Updated Matching Trips from Pickups:",
                  pickupMatchingTrips);
            })
            .catch((error) => {
              console.error("Error in processing requests:", error);
              return null;
            });

        matchCheck(pickupMatchingTrips);

        const destinationRequests = pickupMatchingTrips.map((trip) => {
          const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${trip.destination_description}&strictbounds=True&location=${newTripData.destination_latlng}&radius=${newTripData.destination_radius*2}&key=${apiKey}`;
          return fetch(url)
              .then((response) => {
                if (!response.ok) {
                  throw new Error("Network response was not ok");
                }
                return response.json();
              })
              .then((data) => {
                return {trip, data};
              })
              .catch((error) => {
                console.error("There was a problem with the request:", error);
              });
        });
        Promise.all(destinationRequests)
            .then((results) => {
              const filteredTrips = results.filter((result) => {
                const data = result.data;
                if (data.status === "OK" && data.predictions.length > 0) {
                  // Check if any place description matches the input parameter
                  const descriptions = data.predictions
                      .map((prediction) => prediction.description);
                  return descriptions.some((description) => {
                    return description.toLowerCase()
                        .includes(result.trip.destination_description
                            .toLowerCase());
                  });
                }
                // If no predictions or status is not "OK", exclude this trip
                return false;
              });
              const tripList = filteredTrips
                  .map((filtered) => filtered.trip);
              destinationMatchingTrips.push(tripList);
              console.log("Updated Matching Trips from destinations:",
                  destinationMatchingTrips);
            })
            .catch((error) => {
              console.error("Error in processing requests:", error);
              return null;
            });

        matchCheck(destinationMatchingTrips);

        const distanceMatrixApiUrl = "https://api.distancematrix.ai/maps/api/distancematrix/json";

        const origins = newTripData.pickup_description;
        const destinations = destinationMatchingTrips
            .map((trip) => trip.pickup_description).join("|");

        const distanceMatrixUrl = `${distanceMatrixApiUrl}?origins=${origins}
        &destinations=${destinations}&key=${distanceMatrixApiKey}`;

        try {
          const distanceMatrixResponse = await fetch(distanceMatrixUrl);
          if (!distanceMatrixResponse.ok) {
            throw new Error("DistanceMatrix API request failed");
          }
          const distanceMatrixData = await distanceMatrixResponse.json();
          if (distanceMatrixData.status === "OK") {
            const rows = distanceMatrixData.rows;
            if (rows.length > 0 && rows[0].elements.length > 0) {
              rows[0].elements.forEach((element, index) => {
                const distanceValue = element.distance.value;
                if (distanceValue <= newTripData.pickup_radius*2) {
                  finalPickupTrips
                      .push(destinationMatchingTrips[index]);
                }
              });
            }
          }
          console.log("New Matching Trips within radius from pickups:",
              finalPickupTrips);
        } catch (error) {
          console.error("Error fetching distance matrix:", error);
          return null;
        }

        matchCheck(finalPickupTrips);

        const finalOrigins = newTripData.destination_description;
        const finalDestinations = finalPickupTrips
            .map((trip) => trip.destination_description).join("|");

        const finalDistanceMatrixUrl = `${distanceMatrixApiUrl}
        ?origins=${finalOrigins}
        &destinations=${finalDestinations}&key=${distanceMatrixApiKey}`;

        try {
          const distanceMatrixResponse = await fetch(finalDistanceMatrixUrl);
          if (!distanceMatrixResponse.ok) {
            throw new Error("DistanceMatrix API request failed");
          }
          const distanceMatrixData = await distanceMatrixResponse.json();
          if (distanceMatrixData.status === "OK") {
            const rows = distanceMatrixData.rows;
            if (rows.length > 0 && rows[0].elements.length > 0) {
              rows[0].elements.forEach((element, index) => {
                const distanceValue = element.distance.value;
                if (distanceValue <= newTripData.destination_radius*2) {
                  finalTrips
                      .push(finalPickupTrips[index]);
                }
              });
            }
          }
          console.log("New Matching Trips within radius from destinations:",
              finalTrips);
        } catch (error) {
          console.error("Error fetching distance matrix:", error);
          return null;
        }

        matchCheck(finalTrips);

        const processTrips = async () => {
          const processPromises = finalTrips.map(async (trip) => {
            const poolQuery = await poolRef
                .where("trips", "array-contains", trip).get();
            if (!poolQuery.empty) {
              // Trip found in a pool, update existing pools
              const updatePoolPromises = poolQuery.docs
                  .map(async (docSnapshot) => {
                    const docData = docSnapshot.data();
                    const existingTrips = docData.trips;
                    const newTrips = [...existingTrips, newTripData]
                        .filter((trip) => finalTrips.includes(trip));
                    await docSnapshot.ref.update({trips: newTrips});
                  });
              await Promise.all(updatePoolPromises);
            } else {
              // Trip not found in any pool, create new pool
              await poolRef.add({
                trips: [trip, newTripData],
              });
            }
          });
          await Promise.all(processPromises);
        };
        await processTrips();

        console.log("Matching complete"); // Return a promise or null when done
        return "Matching complete";
      } catch (error) {
        console.error("Function execution halted:", error);
        return null;
      }
    });

