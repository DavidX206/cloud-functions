/* eslint-disable linebreak-style */
// firebaseAdmin.js
const {initializeApp, getApps} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

// Ensure the app is initialized only once
if (!getApps().length) {
  initializeApp();
}


const arrayUnion = FieldValue.arrayUnion;
const del = FieldValue.delete;

const db = getFirestore();
db.settings({ignoreUndefinedProperties: true});

module.exports = {db, arrayUnion, del};
