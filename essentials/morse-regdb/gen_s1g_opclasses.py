#!/usr/bin/env python3
"""Generate s1g_opclasses.csv from IEEE 802.11 2024 Table E-5 (S1G operating classes).

Unlike channels.csv, this table is not the morse supported regulatory data keyed by country; it's the
raw spec table, so that channel test mode can select any operating class/channel
regardless of the region the device is configured for.

Each operating class defines a channel starting frequency and a set of valid channel
numbers; the centre frequency is always:

    centre_freq_mhz = channel_starting_frequency_mhz + channel_number * 0.5

Usage: python3 gen_s1g_opclasses.py > artefacts/s1g_opclasses.csv
"""

import sys

# s1g_op_class: (global_op_class, region, start_freq_mhz, bw_mhz, [channel numbers])
OPERATING_CLASSES = {
    1:  (68, 'US', 902.0,  1,  [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25,
                                27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49, 51]),
    2:  (69, 'US', 902.0,  2,  [2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50]),
    3:  (70, 'US', 902.0,  4,  [8, 16, 24, 32, 40, 48]),
    4:  (71, 'US', 902.0,  8,  [12, 28, 44]),
    5:  (72, 'US', 902.0,  16, [20]),
    6:  (66, 'EU', 863.0,  1,  [1, 3, 5, 7, 9]),
    7:  (67, 'EU', 863.0,  2,  [6]),
    8:  (73, 'JP', 916.5,  1,  [9, 13, 15, 17, 19, 21]),
    9:  (64, 'JP', 922.5,  2,  [2, 6]),
    10: (64, 'JP', 922.5,  2,  [4, 8]),
    11: (65, 'JP', 906.5,  4,  [36]),
    12: (65, 'JP', 906.5,  4,  [38]),
    14: (74, 'KR', 917.5,  1,  [1, 3, 5, 7, 9, 11, 18, 20, 22, 24]),
    15: (75, 'KR', 917.5,  2,  [2, 6, 10, 19, 23]),
    16: (76, 'KR', 917.5,  4,  [8]),
    17: (66, 'SG', 863.0,  1,  [7, 9, 11]),
    18: (68, 'SG', 902.0,  1,  [31, 33, 35, 37, 39, 41, 43, 45]),
    19: (67, 'SG', 863.0,  2,  [10]),
    20: (61, 'SG', 902.0,  2,  [32, 36, 40, 44]),
    21: (62, 'SG', 902.0,  4,  [34, 42]),
    22: (50, 'AU', 902.0,  1,  [28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50]),
    23: (51, 'AU', 902.0,  2,  [29, 33, 37, 41, 45, 49]),
    24: (52, 'AU', 902.0,  4,  [31, 39, 47]),
    25: (53, 'AU', 902.0,  8,  [35, 43]),
    26: (50, 'NZ', 902.0,  1,  [28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50]),
    27: (51, 'NZ', 902.0,  2,  [29, 33, 37, 41, 45, 49]),
    28: (52, 'NZ', 902.0,  4,  [31, 39, 47]),
    29: (53, 'NZ', 902.0,  8,  [35, 43]),
    30: (77, 'EU', 901.4,  1,  [31, 33, 35]),
    31: (63, 'SG', 902.0,  8,  [38]),
    32: (54, 'TW', 902.0,  1,  [38, 40, 42, 44]),
    33: (55, 'TW', 902.0,  2,  [39, 43]),
    34: (56, 'TW', 902.0,  4,  [41]),
    35: (57, 'US', 840.0,  2,  [128, 132, 136, 140, 144, 148, 152, 156, 160, 164, 168, 172]),
    36: (58, 'US', 840.0,  4,  [130, 138, 146, 154, 162, 170]),
    37: (59, 'US', 840.0,  8,  [134, 150, 166]),
    38: (60, 'US', 840.0,  16, [142]),
}


def main():
    out = sys.stdout
    out.write('s1g_op_class,global_op_class,region,bw,s1g_chan,centre_freq_mhz\n')

    for op_class in sorted(OPERATING_CLASSES):
        global_op_class, region, start_freq_mhz, bw, channels = OPERATING_CLASSES[op_class]
        for chan in channels:
            centre_freq_mhz = start_freq_mhz + chan * 0.5
            out.write(f'{op_class},{global_op_class},{region},{bw},{chan},{centre_freq_mhz:.1f}\n')


if __name__ == '__main__':
    main()
