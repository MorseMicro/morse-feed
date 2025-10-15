#!/usr/bin/env python3

# Make the channelization info more computationally tractable.

import csv
import sys

dr = csv.DictReader(sys.stdin)
fieldnames = list(dr.fieldnames)
fieldnames.insert(1, 'channelizations')
fieldnames.insert(2, 'default_channelization')

dw = csv.DictWriter(sys.stdout, fieldnames, lineterminator='\n')
dw.writeheader()
for row in dr:
    if row['country'] == 'Australia':
        row['channelizations'] = '80211_2024;80211_revmf'
        row['default_channelization'] = True
    elif row['country'] == 'Australia Proposed':
        row['country'] = 'Australia'
        row['channelizations'] = '80211_revmf'
        row['default_channelization'] = True
    elif row['country'] == 'Australia 2020':
        row['country'] = 'Australia'
        row['channelizations'] = '80211_2020'
        row['default_channelization'] = False
    else:
        row['channelizations'] = ''
        row['default_channelization'] = True

    dw.writerow(row)
