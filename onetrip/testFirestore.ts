import * as admin from 'firebase-admin';
// import { FieldPath } from 'firebase-admin/firestore';
import * as serviceAccount from '../service-account/starlit-cycle-403120-firebase-adminsdk-j65vo-630de9d3ae.json';
// import * as usersData from '../mock/users.json';
// import * as tripsData from '../mock/trips.json';

// Type definitions
// interface LatLng {
//   lat: number;
//   lng: number;
// }

// interface Transaction {
//   id: string;
//   amount: number;
//   date: Date;
// }

// interface User {
//   email: string;
//   photo_url: string;
//   uid: string;
//   created_time: Date;
//   phone_number: string;
//   first_name: string;
//   last_name: string;
//   transactions: Transaction[];
//   ticket_count: number;
// }

// interface Trip {
//   trip_id: string;
//   trip_group_id?: string;
//   user_id: string;
//   user_ref?: admin.firestore.DocumentReference;
//   trip_group_ref?: admin.firestore.DocumentReference;
//   pickup_description: string;
//   pickup_short_description: string;
//   pickup_address?: string;
//   pickup_latlng: LatLng;
//   pickup_city: string;
//   pickup_radius: number;
//   destination_description: string;
//   destination_short_description: string;
//   destination_address?: string;
//   destination_latlng: LatLng;
//   destination_city: string;
//   destination_radius: number;
//   seat_count: number;
//   start_date_time: string | admin.firestore.Timestamp;
//   start_date_string?: string;
//   end_date_time?: string | admin.firestore.Timestamp | null;
//   end_date_string?: string | null;
//   time_range_array?: string[] | null;
//   total_seat_count: number;
//   status: string;
//   fully_matched: boolean;
//   is_time_fixed: boolean;
//   matched_trips: MatchedTrip[];
//   potential_trips: PotentialTrip[];
//   reserved: boolean;
//   reserving_trip_ref?: admin.firestore.DocumentReference;
//   time_of_creation: string | admin.firestore.Timestamp;
//   time_of_payment?: admin.firestore.Timestamp;
// }

interface MatchedTrip {
  trip_ref: admin.firestore.DocumentReference;
  paid: boolean;
  trip_group_ref: admin.firestore.DocumentReference | string;
  pickup_radius: number;
  destination_radius: number;
  pickup_distance: number;
  destination_distance: number;
  proper_match: boolean;
  seat_count: number;
  reserving?: boolean;
}

interface PotentialTrip {
  trip_ref: admin.firestore.DocumentReference;
  paid: boolean;
  trip_group_ref: admin.firestore.DocumentReference | string;
  pickup_radius: number;
  destination_radius: number;
  pickup_distance: number;
  destination_distance: number;
  proper_match: boolean;
  trip_obstruction: boolean;
  seat_obstruction: boolean;
  reserving_trip_obstruction: boolean;
  mutual: boolean;
  group_largest_pickup_overlap_gap: number | null;
  group_largest_destination_overlap_gap: number | null;
  unknown_trip_obstruction: boolean;
  total_seat_count: number | null;
  seat_count: number;
}

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount)
});

const db = admin.firestore();

db.settings({
  ignoreUndefinedProperties: true,
  host: 'localhost:8080',
  ssl: false,
});

// Sample trip object
// const trip: Trip = {
//   "trip_id": "trip_031",
//   "trip_group_id": "",
//   "user_id": "uid31",
//   "pickup_description": "Millennium Park Abuja",
//   "pickup_short_description": "Millennium Park",
//   "pickup_latlng": {
//     "lat": 9.0563,
//     "lng": 7.5045
//   },
//   "pickup_city": "Abuja",
//   "pickup_radius": 2500,
//   "destination_description": "Transcorp Hilton Hotel",
//   "destination_short_description": "Transcorp Hilton",
//   "destination_latlng": {
//     "lat": 9.0736,
//     "lng": 7.4937
//   },
//   "destination_city": "Abuja",
//   "destination_radius": 2000,
//   "seat_count": 1,
//   "start_date_time": "2024-12-21T17:30:00",
//   "start_date_string": "5:30PM",
//   "total_seat_count": 1,
//   "status": "unmatched",
//   "fully_matched": false,
//   "is_time_fixed": true,
//   "matched_trips": [],
//   "potential_trips": [],
//   "reserved": false,
//   "time_of_creation": "2024-12-21T16:00:00"  
// };

// async function addUsersToCollection(): Promise<void> {
//   for (const user of (usersData as any[]).map(data => ({
//     ...data,
//     created_time: new Date(data.created_time),
//     transactions: data.transactions.map((transaction: any) => ({
//       ...transaction,
//       date: new Date(transaction.date),
//     })),
//   })) as User[]) {
//     try {
//       await db.collection("users").doc(user.uid).set(user);
//       console.log(`User ${user.uid} added successfully.`);
//     } catch (error) {
//       console.error(`Error adding user ${user.uid}:`, error);
//     }
//   }
// }

// async function addUserToCollection(): Promise<void> {
//   const user: User = {
//     email: "user31@example.com",
//     photo_url: "images/user31.jpg",
//     uid: "uid31",
//     created_time: new Date("2023-02-01T10:00:00Z"),
//     phone_number: "+1234567891",
//     first_name: "Alice",
//     last_name: "Smith",
//     transactions: [
//       { id: "tx3", amount: 75, date: new Date("2023-05-01T14:00:00Z") },
//     ],
//     ticket_count: 1,
//   };
//   try {
//     await db.collection("users").doc(user.uid).set(user);
//     console.log(`User ${user.uid} added successfully.`);
//   } catch (error) {
//     console.error(`Error adding user ${user.uid}:`, error);
//   }
// }

// const assignTripsToUsers = async (): Promise<void> => {
//   try {
//     const users = (usersData as any[]).map(data => ({
//       ...data,
//       created_time: new Date(data.created_time),
//       transactions: data.transactions.map((transaction: any) => ({
//         ...transaction,
//         date: new Date(transaction.date),
//       })),
//     })) as User[];
//     const trips = tripsData as Trip[];
    
//     for (let i = 0; i < users.length; i++) {
//       const user = users[i];
//       const trip = trips[i]; // Each user gets one trip

//       const userRef = db.collection("users").doc(user.uid);
//       const tripsCollection = userRef.collection("trips");

//       await tripsCollection.doc(trip.trip_id).set(trip);

//       console.log(`Assigned trip ${trip.trip_id} to user ${user.uid}.`);
//     }
//     console.log("All trips have been assigned to users.");
//   } catch (error) {
//     console.error("Error assigning trips to users:", error);
//   }
// };

// const assignTripToUser = async (): Promise<void> => {
//   try {
//     const userRef = db.collection("users").doc("uid31");
//     const tripsCollection = userRef.collection("trips");

//     await tripsCollection.doc(trip.trip_id).set(trip);

//     console.log(`Assigned trip ${trip.trip_id} to user uid31.`);
//   } catch (error) {
//     console.error("Error assigning trip to user:", error);
//   }
// };

// const getOldTripData = async (tripId: string, userId: string): Promise<[Trip, admin.firestore.DocumentReference] | null> => {
//   try {
//     // Get the specific trip document reference under the user's collection
//     const oldTripDocRef = db
//       .collection(`users/${userId}/trips`)
//       .doc(tripId);

//     const oldTripDoc = await oldTripDocRef.get();

//     if (oldTripDoc.exists) {
//       const oldTripData = oldTripDoc.data() as Trip;
//       return [oldTripData, oldTripDocRef];
//     } else {
//       console.log("Old trip document does not exist");
//       return null;
//     }
//   } catch (error) {
//     console.error("Error in getOldTripData:", error);
//     return null;
//   }
// };


type ArrayFieldToDetails = {
  matched_trips: MatchedTrip;
  potential_trips: PotentialTrip;
};

function updateNestedTripField<K extends keyof ArrayFieldToDetails, T extends keyof ArrayFieldToDetails[K]>(
  updateObj: Record<string, any>,
  arrayField: K,
  index: number,
  fieldToUpdate: T,
  newValue: ArrayFieldToDetails[K][T]
): void {
  if (index === -1) {
    console.warn(`Index ${index} not found in ${arrayField}.`);
    return;
  }
  
  updateObj[`${arrayField}.${index}.${String(fieldToUpdate)}`] = newValue;
}
// Function to remove array elements by ID
// function removeArrayElementById(
//   updateObj: Record<string, any>,
//   arrayField: "matched_trips" | "potential_trips",
//   idToRemove: string,
//   idField: string = 'trip_ref'
// ): void {
//   const tripRef = db.collection('trips').doc(idToRemove);
//   updateObj[arrayField] = FieldValue.arrayRemove({
//     [idField]: tripRef
//   });
// }

const reservingTripUpdate: Record<string, any> = {};

const reservingTripRef = db
  .collection(`users/uid1/trips`)
  .doc("trip1");



(async () => {
  // await addUsersToCollection();
  // await assignTripsToUsers();
  // Example of how to use the updateNestedTripField function
  await updateNestedTripField(reservingTripUpdate, 'matched_trips', 0, 'seat_count', 2);
  await updateNestedTripField(reservingTripUpdate, 'matched_trips', 0, 'paid', true);
  await updateNestedTripField(reservingTripUpdate, 'matched_trips', 0, 'reserving', false);
  await reservingTripRef.update(reservingTripUpdate);
  console.log("Updated reserving trip successfully.");
})();