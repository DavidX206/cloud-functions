import { DocumentReference, Timestamp } from 'firebase-admin/firestore'; 

// User types
interface User {
  email: string;
  photo_url: string;
  uid: string;
  created_time: Timestamp;
  phone_number: string;
  first_name: string;
  last_name: string;
  date_of_birth: Timestamp;
  transactions: Record<string, any>[];
  ticket_count: number;
}

// Trip types
interface Trip {
  trip_id: string;
  user_ref: DocumentReference;
  trip_group_ref: DocumentReference;
  pickup_description: string;
  pickup_short_description: string;
  pickup_address: string;
  pickup_latlng: LatLng;
  pickup_city: string;
  pickup_radius: number;
  destination_description: string;
  destination_short_description: string;
  destination_address: string;
  destination_latlng: LatLng;
  destination_city: string;
  destination_radius: number;
  seat_count: number;
  start_date_time: Timestamp;
  end_date_time: Timestamp;
  time_range_array: string[];
  total_seat_count: number;
  status: string;
  fully_matched: boolean;
  is_time_fixed: boolean;
  matched_trips: MatchedTrip[];
  potential_trips: PotentialTrip[];
  reserved: boolean;
  reserving_trip_ref: DocumentReference;
  time_of_creation: Timestamp;
  time_of_payment: Timestamp;
  last_notification_time: Timestamp;
  pending_edit_count: number;
  pending_edit_gaps: [];
  trip_alerts: {}[];
}

interface LatLng {
  lat: number;
  lng: number;
}

interface MatchedTrip {
  trip_ref: DocumentReference;
  trip_group_ref: DocumentReference | null;
  paid: boolean;
  pickup_radius: number;
  destination_radius: number;
  pickup_distance: number;
  destination_distance: number;
  mutual: boolean;
  reserving: boolean;
  seat_count: number; //check add seat_count to matched trip and potential trip
}

interface PotentialTrip {
  trip_ref: DocumentReference;
  paid: boolean;
  trip_group_ref: DocumentReference | null;
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

// Trip Group types
interface TripGroup {
  trip_group_members:TripGroupMember[];
  recent_message: RecentMessage | null;
  total_seat_count: number;
  potential_trip_members: PotentialTripMember[];
  pickup_location_suggestions: PickupLocationSuggestion[];
  destination_suggestions: DestinationSuggestion[];
}

interface TripGroupMember {
  trip_ref: DocumentReference;
  user_ref: DocumentReference;
  first_name: string;
  last_name: string;
  phone_number: string;
  photo_url: string;
  seat_count: number;
  joined_timestamp: Timestamp;
  last_message_read_id: string;
  time_range_array: string[];
  arrived: boolean;
  trip_group_leader: boolean;
  canceled: boolean;
}

interface RecentMessage {
  message_id: string;
  message_ref: DocumentReference;
  message_type: string;
  message: string;
  audio?: string;
  user_ref: DocumentReference;
  from_first_name: string;
  timestamp: Timestamp;
  seenBy: string[];
}

interface PotentialTripMember {
  trip_ref: DocumentReference;
  obstructing_trip_members: ObstructingTripMember[];
  trip_obstruction: boolean;
  seat_obstruction: boolean;
  seat_count: number;
  unknown_trip_obstruction: boolean;
}

interface ObstructingTripMember {
  trip_ref: DocumentReference;
  pickup_overlap_gap: number | null;
  destination_overlap_gap: number | null;
  unknown: boolean;
}

interface PickupLocationSuggestion {
  pickup_suggestion_name: string;
  pickup_suggestion_address: string;
  pickup_suggestion_location: LatLng;
  distances_from_trip_pickup_locations: DistanceFromLocation[];
  pickup_suggestion_voters: string[];
}

interface DestinationSuggestion {
  destination_suggestion_name: string;
  destination_suggestion_address: string;
  destination_suggestion_location: LatLng;
  distances_from_trip_destinations: DistanceFromLocation[];
  destination_suggestion_voters: string[];
}

interface DistanceFromLocation {
  trip_id: string;
  walking_distance: number;
}

interface PotentialTripToBeAdded {
    paid: boolean;
    trip_group_ref: DocumentReference | "";
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

interface MatchedTripToBeAdded {
    trip_group_ref: DocumentReference | "";
    paid: boolean;
    mutual: boolean;
    reserving: boolean;
    seat_count: number;
  }

interface Message {
  message_type: string;
  user_ref: DocumentReference;
  message: string;
  timestamp: Timestamp;
  audio?: string;
  image?: string;
  photo_url?: string;
  first_name: string;
  last_name: string;
  seenBy: string[];
  newly_paid_trip_ref: DocumentReference;
  redundant: boolean;
  system_message: boolean;
  new_pickup_suggestion: boolean;
  new_destination_suggestion: boolean;
  group_time_range_array_changed: boolean;
  group_time_range_array: string[];
}

interface TripGroupInfo{
  tripGroupId: string,
  tripObstruction: boolean,
  seatObstruction: boolean,
  largestPickupOverlapGap: number | null,
  largestDestinationOverlapGap: number | null,
}

type ArrayFieldToDetails = {
  matched_trips: MatchedTrip;
  potential_trips: PotentialTrip;
  destination_suggestions: DestinationSuggestion;
  pickup_location_suggestions: PickupLocationSuggestion;
};

export type {
  User,
  Trip,
  MatchedTrip,
  PotentialTrip,
  MatchedTripToBeAdded,
  PotentialTripToBeAdded,
  LatLng,
  TripGroup,
  TripGroupMember,
  RecentMessage,
  PotentialTripMember,
  ObstructingTripMember,
  PickupLocationSuggestion,
  DestinationSuggestion,
  DistanceFromLocation,
  Message,
  TripGroupInfo,
  ArrayFieldToDetails,
};