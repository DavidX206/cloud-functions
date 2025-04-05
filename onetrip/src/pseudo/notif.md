WHEN Trip B is added to Trip A's potential_trips:
    // Constants
    Rmax = 5000  // Maximum radius in meters
    O = 150      // Required overlap in meters
    NOTIFICATION_COOLDOWN = 180000  // 3 minutes in milliseconds (adjust as needed)
    
    // Only proceed if Trip A is unpaid
    IF Trip A is unpaid THEN
        // Step 1: Validate Trip A against the newly added Trip B
        IF Edit_To_Match_Possible(Trip_A, Trip_B, Gp_out, Gd_out, seat_reduction_out) THEN
            // Step 2: Check notification cooldown
            current_time = NOW()  // Server timestamp
            last_notification_time = Trip_A.last_notification_time  // Field in trips document, default null
            
            // Calculate unique edit signature (Gp, Gd, seat_reduction)
            edit_signature = (Gp_out, Gd_out, seat_reduction_out)  // Tuple of pickup gap, destination gap, and seat reduction
            
            IF last_notification_time IS NULL OR 
               (current_time - last_notification_time >= NOTIFICATION_COOLDOWN) THEN
                // Cooldown expired or first notification
                pending_count = Trip_A.pending_edit_count  // Default 0
                pending_gaps = Trip_A.pending_edit_gaps    // Array of (Gp, Gd, seat_reduction) tuples, default empty
                
                // Include this trip in the count
                IF edit_signature NOT IN pending_gaps THEN
                    pending_gaps = pending_gaps + [edit_signature]
                    pending_count = pending_count + 1
                ENDIF
                
                // Notify with count
                NOTIFY TRIP A: "You have " + pending_count + " new edit options available! Tap to see details."
                
                // Reset tracking fields
                UPDATE Trip_A SET 
                    last_notification_time = current_time,
                    pending_edit_count = 0,
                    pending_edit_gaps = []
            ELSE
                // Within cooldown: Accumulate editable trips
                pending_count = Trip_A.pending_edit_count  // Default 0
                pending_gaps = Trip_A.pending_edit_gaps    // Default empty
                
                // Increment count and store unique gaps
                IF edit_signature NOT IN pending_gaps THEN
                    pending_gaps = pending_gaps + [edit_signature]
                    pending_count = pending_count + 1
                ENDIF
                
                UPDATE Trip_A SET 
                    pending_edit_count = pending_count,
                    pending_edit_gaps = pending_gaps
            ENDIF
        ENDIF
    ENDIF

// Function to check if edits can make a match possible, returning gaps and seat reduction
FUNCTION Edit_To_Match_Possible(Trip_A, Trip_B, OUT Gp_out, OUT Gd_out, OUT seat_reduction_out):
    IF NOT (reserving_trip_obstruction) AND NOT (unknown_trip_obstruction) THEN
        seats_available_B = 4 - total_seat_count_B
        seat_reduction_needed = max(0, seat_count_A - seats_available_B)  // How many seats Trip A must reduce
        
        IF Trip B is paid THEN
            Gp = group_largest_pickup_overlap_gap
            Gd = group_largest_destination_overlap_gap
            IF (Gp <= (Rmax - pickup_radius_A)) AND
               (Gd <= (Rmax - destination_radius_A)) AND
               (seat_reduction_needed <= seat_count_A - 1) THEN  // Ensure at least 1 seat remains
                Gp_out = Gp
                Gd_out = Gd
                seat_reduction_out = seat_reduction_needed
                RETURN true
            ENDIF
        
        ELSE
            // Both unpaid: Check individual closability if not a proper match
            proper_match = (pickup_radius_A + pickup_radius_B >= pickup_distance + O) AND
                          (destination_radius_A + destination_radius_B >= destination_distance + O)
            IF proper_match IS false
                Gp = max(0, (pickup_distance + O) - (pickup_radius_A + pickup_radius_B))
                Gd = max(0, (destination_distance + O) - (destination_radius_A + destination_radius_B))
                IF (Gp <= (Rmax - pickup_radius_A)) AND
                   (Gd <= (Rmax - destination_radius_A)) THEN
                    Gp_out = Gp
                    Gd_out = Gd
                    seat_reduction_out = 0 // No seat edit needed
                    RETURN true
                ENDIF
            ENDIF
        ENDIF
    ENDIF
    Gp_out = 0  // Default if no match
    Gd_out = 0
    seat_reduction_out = 0
    RETURN false