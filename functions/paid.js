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
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");


// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const axios = require("axios");
const db = getFirestore();


initializeApp();

db.settings({ignoreUndefinedProperties: true});


exports.paidFunction = onDocumentUpdated("users/{userId}/trips/{tripId}",
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
        const newTripData = snapshot.after.data();
        const previousData = event.data.before.data();

        if (newTripData.paid === previousData.paid || newTripData.paid===false) {
            return null;
        }

        const getTripGroupData = (tripGroupID) => {
            const oldTripGroupRef = db.collectionGroup("trip_groups").doc(tripGroupID);
            oldTripGroupRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripGroupDocRef = db
                        .collection(`users/${userId}/trip_groups`)
                        .doc(tripGroupID);
                    const oldTripGroupDoc = await oldTripGroupDocRef.get();
                    const oldTripGroupData = oldTripGroupDoc.docs.data();
                    return oldTripGroupData;
                }
            });
        };

        const getOldTripDocRef = async (tripId) => {
            const oldTripRef = db.collectionGroup("trips").doc(tripId);
            oldTripRef.get().then(async (doc) => {
                if (doc.exists) {
                    const userRef = doc.ref.parent.parent;
                    const userId = userRef.id;
                    const oldTripDocRef = db
                        .collection(`users/${userId}/trips`)
                        .doc(tripId);
                    return oldTripDocRef;
                }
            });
        };

        try {
            if (newTripData.reserved === true) {
                await newTripDocRef.update({
                    trip_group_id: newTripData.reserving_trip_id,
                    total_seat_count: newTripData.seat_count + getTripGroupData().total_seat_count,
                    reserved: false,
                });
                getOldTripDocRef(newTripData.reserving_trip_id);
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
