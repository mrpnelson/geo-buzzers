/* Rule4 Buzzer Enclosure (V5.0 - Interior Face Engraved Text) */
$fn = 64;

// --- DIMENSIONS ---
width = 85;
length = 85;
height = 38;
wall = 2.4;
corner_radius = 12;
bevel = 3.5;

// --- COMPONENT CLEARANCES ---
buzzer_d = 7.5;
power_d = 12.5;
led_d = 8.0;
usbc_w = 9.5;
usbc_h = 4.5;
pcb_w = 17; 
pcb_l = 20;

// --- CALCULATED SPACING ---
lid_inset = bevel + 1.5;
lid_w = width - 2*lid_inset;
lid_l = length - 2*lid_inset;
lid_r = corner_radius - bevel;
lid_h = 2.4;

usbc_z_offset = 2; 
usbc_z = bevel + 1.5 + (usbc_h / 2) + usbc_z_offset;

// --- FASTENER & CORNER BLOCK HARDWARE (M3) ---
insert_d = 4.2;      
insert_depth = 6.0;  
boss_size = 17.0;    
boss_h = 9.0;        
screw_hole_d = 3.4;  
head_d = 6.2;        

corner_offset_x = 11.0; 
corner_offset_y = 11.0; 

// ==========================================
// GEOMETRY MODULES
// ==========================================

module filleted_box(w, l, h, r, b) {
    hull() {
        for(x = [r, w-r]) {
            for(y = [r, l-r]) {
                translate([x, y, b]) 
                    rotate_extrude() translate([r - b, 0, 0]) circle(r = b);
                translate([x, y, h - b]) 
                    rotate_extrude() translate([r - b, 0, 0]) circle(r = b);
            }
        }
    }
}

module rounded_rect(w, l, h, r) {
    hull() {
        translate([r, r, 0]) cylinder(r=r, h=h);
        translate([w-r, r, 0]) cylinder(r=r, h=h);
        translate([r, l-r, 0]) cylinder(r=r, h=h);
        translate([w-r, l-r, 0]) cylinder(r=r, h=h);
    }
}

// ==========================================
// MAIN PARTS
// ==========================================

module top_shell() {
    difference() {
        // Outer Shell
        filleted_box(width, length, height, corner_radius, bevel);
        
        // 1. THE HOLLOW CAVITY (With corners protected)
        difference() {
            hull() {
                for(x = [corner_radius, width-corner_radius]) {
                    for(y = [corner_radius, length-corner_radius]) {
                        translate([x, y, bevel]) 
                            rotate_extrude() translate([corner_radius - wall - (bevel - wall), 0, 0]) circle(r = bevel - wall);
                        translate([x, y, height - wall - (bevel - wall)]) 
                            rotate_extrude() translate([corner_radius - wall - (bevel - wall), 0, 0]) circle(r = bevel - wall);
                    }
                }
            }
            
            translate([-1, -1, bevel]) cube([boss_size + 1, boss_size + 1, boss_h]);
            translate([width - boss_size, -1, bevel]) cube([boss_size + 1, boss_size + 1, boss_h]);
            translate([-1, length - boss_size, bevel]) cube([boss_size + 1, boss_size + 1, boss_h]);
            translate([width - boss_size, length - boss_size, bevel]) cube([boss_size + 1, boss_size + 1, boss_h]);
        }
        
        // 2. Base Opening Cutout
        translate([lid_inset, lid_inset, -0.1])
            rounded_rect(lid_w, lid_l, bevel + 0.1, lid_r);
        
        // Center Buzzer Button Hole
        translate([width/2, length/2, height - wall - 1])
            cylinder(d=buzzer_d, h=wall + 2);
            
        // Power Button Hole
        translate([corner_radius + 6, length - corner_radius - 6, height - wall - 1])
            cylinder(d=power_d, h=wall + 2);
            
        // NeoPixel Lens Hole
        translate([width - corner_radius - 6, length - corner_radius - 6, height - wall - 1])
            cylinder(d=led_d, h=wall + 2);
            
        // USB-C Cutout 
        translate([width/2, length - wall - 1, usbc_z])
            rotate([-90, 0, 0])
            hull() {
                translate([-usbc_w/2 + usbc_h/2, 0, 0]) cylinder(d=usbc_h, h=wall + 2);
                translate([usbc_w/2 - usbc_h/2, 0, 0]) cylinder(d=usbc_h, h=wall + 2);
            }
            
        // ==========================================
        // VENTILATION SLOTS 
        // ==========================================
        vent_h = 12;
        vent_w = 1;
        vent_space = 1.25;
        usb_top_z = usbc_z + (usbc_h / 2);
        bevel_start_z = height - bevel;
        vent_z = usb_top_z + ((bevel_start_z - usb_top_z) / 2) - (vent_h / 2);
        
        for(i = [-3 : 3]) {
            translate([width/2 - (vent_w/2) + i*(vent_w + vent_space), length - wall - 1, vent_z])
                cube([vent_w, wall + 2, vent_h]);
        }
            
        // ==========================================
        // RULE4 LOGO EMBOSS
        // ==========================================
        translate([18, 15, height - 1.2]) 
            linear_extrude(height = 3) 
            scale([1.05, 1.05, 1]) 
            import("rule4_logo.svg");

        // ==========================================
        // M3 HEAT-SET INSERT PILOT HOLES
        // ==========================================
        for(x_pos = [corner_offset_x, width - corner_offset_x]) {
            for(y_pos = [corner_offset_y, length - corner_offset_y]) {
                translate([x_pos, y_pos, bevel - 0.1])
                    cylinder(d=insert_d, h=insert_depth + 0.2);
            }
        }
    }
    
    // ==========================================
    // CAPTURED TP4056 SHELF MOUNT (ANCHORED TO REAR WALL)
    // ==========================================
    shelf_width = pcb_w + 8; 
    shelf_depth = pcb_l;
    shelf_h = usbc_z - (usbc_h / 2) - bevel; 
    
    wall_anchored_depth = length - wall - (length - lid_inset - shelf_depth);

    translate([width/2 - shelf_width/2, length - lid_inset - shelf_depth, bevel]) {
        cube([shelf_width, wall_anchored_depth, shelf_h]);
        
        col_w = 3;
        col_d = 4;
        col_h = height - wall - (bevel + shelf_h);
        
        translate([0, 0, shelf_h]) cube([col_w, col_d, col_h]);
        translate([shelf_width - col_w, 0, shelf_h]) cube([col_w, col_d, col_h]);
        translate([0, shelf_depth - col_d, shelf_h]) cube([col_w, col_d, col_h]);
        translate([shelf_width - col_w, shelf_depth - col_d, shelf_h]) cube([col_w, col_d, col_h]);
    }
    
    // ==========================================
    // NEOPIXEL ALIGNMENT FENCE
    // ==========================================
    led_cx = width - corner_radius - 6;
    led_cy = length - corner_radius - 6;
    fence_id = 11.0; 
    fence_od = 14.0; 
    fence_h = 5.0;   
    
    translate([led_cx, led_cy, height - wall - fence_h]) {
        difference() {
            cylinder(d=fence_od, h=fence_h);
            translate([0, 0, -0.1])
                cylinder(d=fence_id, h=fence_h + 0.2);
            
            rotate([0, 0, 180])
                translate([-4.5, 0, -0.1])
                cube([9, 10, fence_h + 0.2]);
        }
    }
}

module led_lens() {
    translate([width - corner_radius - 6, length - corner_radius - 6, height - wall])
        cylinder(d=led_d, h=wall);
}

module countersink_hole() {
    union() {
        translate([0, 0, -0.1])
            cylinder(d=screw_hole_d, h=lid_h + 0.2);
        translate([0, 0, -0.1])
            cylinder(d1=head_d, d2=screw_hole_d, h=(head_d - screw_hole_d)/2 + 0.1);
    }
}

module bottom_lid() {
    clearance = 0.2; 
    
    difference() {
        translate([lid_inset + clearance, lid_inset + clearance, 0])
            rounded_rect(lid_w - 2*clearance, lid_l - 2*clearance, lid_h, lid_r);
            
        // --- 4 CORNER COUNTERSUNK SCREW HOLES ---
        translate([corner_offset_x, corner_offset_y, 0]) countersink_hole();
        translate([width - corner_offset_x, corner_offset_y, 0]) countersink_hole();
        translate([corner_offset_x, length - corner_offset_y, 0]) countersink_hole();
        translate([width - corner_offset_x, length - corner_offset_y, 0]) countersink_hole();

        // ==========================================
        // INTERIOR BASE PLATE TEXT ENGRAVING (Inside Face)
        // ==========================================
        translate([width/2, length/2, lid_h - 0.6]) {
            linear_extrude(height = 0.7) {
                translate([0, 8, 0])
                    text("RULE4", size = 5.0, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
                translate([0, 0, 0])
                    text("SEASON 9", size = 3.5, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
                translate([0, -6, 0])
                    text("COMMEMORATIVE", size = 3.5, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
                translate([0, -12, 0])
                    text("EDITION BUZZER", size = 3.5, font = "Liberation Sans:style=Bold", halign = "center", valign = "center");
            }
        }
    }
}

// ==========================================
// RENDER ASSEMBLY
// ==========================================
top_shell();
//led_lens();
translate([0, 0, -20]) bottom_lid();
