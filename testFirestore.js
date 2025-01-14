
const admin = require("firebase-admin");
const serviceAccount = process.env.SERVICE_ACCOUNT;
const users = require("./mock/users.json");
const trips = require("./mock/trips.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

db.settings({ignoreUndefinedProperties: true,
  host: 'localhost:8080',
  ssl: false,
});

// const trip = {
//   trip_id: "trip1",
//   user_id: "uid31", // Link to user
//   pickup_description: "Millennium Park Abuja",
//   pickup_short_description: "Millennium Park",
//   pickup_latlng: { "lat": 9.0563, "lng": 7.5045 },
//   pickup_radius: 1500,
//   destination_description: "Jabi Recreational Park",
//   destination_short_description: "Jabi Park",
//   destination_latlng: { "lat": 9.0652, "lng": 7.4257 },
//   destination_radius: 2500,
//   seat_count: 1,
//   start_date_time: "2024-12-21T17:30:00Z",
//   start_date_string: "5:30PM",
//   end_date_time: "2024-12-21T18:30:00Z",
//   end_date_string: "6:30PM",
//   time_range_array: ["2024-12-21T17:30:00Z", "2024-12-21T18:30:00Z"],
//   status: "unmatched",
//   is_time_fixed: false,
//   reserved: false,
// };


// Add a document to the "users" collection

const trip = {
    "trip_id": "trip_031",
    "trip_group_id": "",
    "user_id": "uid31",
    "pickup_description": "Millennium Park Abuja",
    "pickup_short_description": "Millennium Park",
    "pickup_latlng": {
      "lat": 9.0563,
      "lng": 7.5045
    },
    "pickup_city": "Abuja",
    "pickup_radius": 2500,
    "destination_description": "Transcorp Hilton Hotel",
    "destination_short_description": "Transcorp Hilton",
    "destination_latlng": {
      "lat": 9.0736,
      "lng": 7.4937
    },
    "destination_city": "Abuja",
    "destination_radius": 2000,
    "seat_count": 1,
    "start_date_time": "2024-12-21T17:30:00",
    "start_date_string": "5:30PM",
    "total_seat_count": 1,
    "status": "unmatched",
    "fully_matched": false,
    "is_time_fixed": true,
    "matched_trips": [],
    "potential_trips": [],
    "reserved": false,
    "time_of_creation": "2024-12-21T16:00:00"  
};


// const trip = {
//   "trip_id": "trip_031",
//   "trip_group_id": "",
//   "user_id": "uid31",
//   "pickup_description": "Nigerian Customs Service Headquarters",
//   "pickup_short_description": "Customs HQ",
//   "pickup_latlng": {
//     "lat": 9.0406,
//     "lng": 7.4863
//   },
//   "pickup_city": "Abuja",
//   "pickup_radius": 3425,
//   "destination_description": "Nigerian Communications Commission (NCC)",
//   "destination_short_description": "NCC",
//   "destination_latlng": {
//     "lat": 9.0532,
//     "lng": 7.4781
//   },
//   "destination_city": "Abuja",
//   "destination_radius": 4521,
//   "seat_count": 2,
//   "start_date_time": "2024-12-21T18:30:00",
//   "start_date_string": "06:30PM",
//   "end_date_time": null,
//   "end_date_string": null,
//   "time_range_array": null,
//   "total_seat_count": 2,
//   "status": "unmatched",
//   "fully_matched": false,
//   "is_time_fixed": true,
//   "matched_trips": [],
//   "potential_trips": [],
//   "reserved": false,
//   "time_of_creation": "2024-12-28T11:35:35.626084"
// }

async function addUsersToCollection() {

  for (const user of users) {
    try {
      await db.collection("users").doc(user.uid).set(user);
      console.log(`User ${user.uid} added successfully.`);
    } catch (error) {
      console.error(`Error adding user ${user.uid}:`, error);
    }
  }
}

async function addUserToCollection() {
  const user ={
    email: "user31@example.com",
    photo_url: "images/user31.jpg",
    uid: "uid31",
    created_time: new Date("2023-02-01T10:00:00Z"),
    phone_number: "+1234567891",
    first_name: "Alice",
    last_name: "Smith",
    transactions: [
      { id: "tx3", amount: 75, date: new Date("2023-05-01T14:00:00Z") },
    ],
    ticket_count: 1,
  };
  try {
    await db.collection("users").doc(user.uid).set(user);
    console.log(`User ${user.uid} added successfully.`);
  } catch (error) {
    console.error(`Error adding user ${user.uid}:`, error);
  }
}

const assignTripsToUsers = async () => {
  try {
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const trip = trips[i]; // Each user gets one trip

      const userRef = db.collection("users").doc(user.uid);
      const tripsCollection = userRef.collection("trips");

      await tripsCollection.doc(trip.trip_id).set(trip);

      console.log(`Assigned trip ${trip.trip_id} to user ${user.uid}.`);
    }
    console.log("All trips have been assigned to users.");
  } catch (error) {
    console.error("Error assigning trips to users:", error);
  }
};

const assignTripToUser = async () => {
  try {
    const userRef = db.collection("users").doc("uid31");
    const tripsCollection = userRef.collection("trips");

    await tripsCollection.doc(trip.trip_id).set(trip);

    console.log(`Assigned trip ${trip.trip_id} to user ${user.uid}.`);
  } catch (error) {
    console.error("Error assigning trip to user:", error);
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


(async () => {
  await addUsersToCollection();
  await assignTripsToUsers();
})();

