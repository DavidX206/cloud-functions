import { Timestamp } from 'firebase-admin/firestore'; 

// User types
interface User {
  email: string;
  photo_url: string;
  uid: string;
  created_time: Timestamp;
  phone_number: string;
  first_name: string;
  last_name: string;
  transactions: Record<string, any>[];
  ticket_count: number;
  trips?: Trip[]; // Optional subcollection
}

// Trip types
interface Trip {
  trip_id: string;
  trip_group_id: string;
  user_id: string;
  pickup_description: string;
  pickup_short_description: string;
  pickup_latlng: LatLng;
  pickup_city: string;
  pickup_radius: number;
  destination_description: string;
  destination_short_description: string;
  destination_latlng: LatLng;
  destination_city: string;
  destination_radius: number;
  seat_count: number;
  start_date_time: Timestamp;
  start_date_string: string;
  end_date_time: Timestamp;
  end_date_string: string;
  time_range_array: any[];
  total_seat_count: number;
  status: string;
  fully_matched: boolean;
  is_time_fixed: boolean;
  matched_trips: MatchedTrip[];
  potential_trips: PotentialTrip[];
  reserved: boolean;
  reserving_trip_id: string;
  reserving_trip_user_id: string;
  time_of_creation: Timestamp;
  time_of_payment: Timestamp;
}

interface LatLng {
  lat: number;
  lng: number;
}

interface MatchedTrip {
  trip_id: string;
  user_id: string;
  trip_group_id: string;
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
  trip_id: string;
  user_id: string;
  paid: boolean;
  trip_group_id: string;
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
  trip_group_id: string;
  trip_group_members:TripGroupMember[];
  recent_message: RecentMessage;
  total_seat_count: number;
  potential_trip_members: PotentialTripMember[];
  pickup_location_suggestions: PickupLocationSuggestion[];
  destination_suggestions: DestinationSuggestion[];
  messages?: Message[]; // Optional subcollection
}

interface TripGroupMember {
  trip_id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone_number: string;
  photo_url: string;
  seat_count: number;
  joined_timestamp: Timestamp;
  last_message_read_id: string;
  earliest_date_time: Timestamp;
  latest_date_time: Timestamp;
}

interface RecentMessage {
  message_id: string;
  message_type: string;
  message: string;
  audio?: string;
  from_id: string;
  from_first_name: string;
  timestamp: Timestamp;
  seenBy: string[];
}

interface PotentialTripMember {
  trip_id: string;
  user_id: string;
  obstructing_trip_members: ObstructingTripMember[];
  trip_obstruction: boolean;
  seat_obstruction: boolean;
  seat_count: number;
  unknown_trip_obstruction: boolean;
}

interface ObstructingTripMember {
  trip_id: string;
  pickup_overlap_gap: number;
  destination_overlap_gap: number;
  unknown: boolean;
}

interface PickupLocationSuggestion {
  pickup_suggestion_name: string;
  pickup_suggestion_address: string;
  pickup_suggestion_location: LatLng;
  distances_from_trip_pickup_locations: DistanceFromLocation[];
}

interface DestinationSuggestion {
  destination_suggestion_name: string;
  destination_suggestion_address: string;
  destination_suggestion_location: LatLng;
  distances_from_trip_destinations: DistanceFromLocation[];
}

interface DistanceFromLocation {
  trip_id: string;
  walking_distance: number;
}

interface PotentialTripToBeAdded {
    paid: boolean;
    trip_group_id: string;
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
    trip_group_id: string;
    paid: boolean;
    mutual: boolean;
    reserving: boolean;
    seat_count: number;
  }

interface Message {
  message_id: string;
  message_type: string;
  from_id: string;
  message: string;
  timestamp: Timestamp;
  audio?: string;
  image?: string;
  photo_url?: string;
  first_name: string;
  last_name: string;
  seenBy: string[];
  redundant: boolean;
}

interface TripGroupInfo{
  tripGroupId: string,
  tripObstruction: boolean,
  seatObstruction: boolean,
  largestPickupOverlapGap: number,
  largestDestinationOverlapGap: number,
}

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
};