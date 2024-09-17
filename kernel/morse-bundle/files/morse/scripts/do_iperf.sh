#!/bin/sh

function usage {
    echo "Usage: $(basename $0) [-m MODE (udp/tcp)] [-s SERVER (IP ADDRESS)] [-p PORT] [-t duration] [-b MAXRATE] [-d DIRECTION] [-n DATASETNAME]" 2>&1
        echo 'Run iperf3 client and collect netlink data via mmnlspy'
        echo '   -i INTERFACE   network interface. (eg. wlan0)     REQUIRED'
        echo '   -m MODE        Specify mode as udp or tcp         REQUIRED'
        echo '   -s SERVERIP    iperf3 server IP address           REQUIRED'
        echo '   -p SERVERPORT  iperf3 port'
        echo '   -t DURATION    iperf3 run duration in seconds     REQUIRED'
        echo '   -b RATE        max throughput for udp (eg. 25m)'
        echo '   -d DIRECTION   up/down. run both if not specified'
        echo '   -n             prefix used for generated files    REQUIRED'
        exit 1
}

function print_out {
   local MESSAGE="${@}"
   if [[ "${VERBOSE}" == true ]];then
      echo "${MESSAGE}"
   fi
}

if [[ ${#} -eq 0 ]]; then
   usage
fi

optstring=":i:m:s:p:t:b:d:n:"

PORT=5201
MAXRATE=25m
MODE=""
OPTCOUNT=0
DATASETNAME=

while getopts ${optstring} arg; do
  case ${arg} in
    i)
      INTERFACE="${OPTARG}"
      let OPTCOUNT++
      ;;
    m)
      MODE="${OPTARG}"
      let OPTCOUNT++
      ;;
    s)
      SERVER="${OPTARG}"
      let OPTCOUNT++
      ;;
    p)
      PORT="${OPTARG}"
      ;;
    t)
      DURATION="${OPTARG}"
      let OPTCOUNT++
      ;;
    b)
      MAXRATE="${OPTARG}"
      ;;
    d)
      DIRECTION="${OPTARG}"
      ;;
    n)
      DATASETNAME="${OPTARG}"
      let OPTCOUNT++
      ;;
    ?)
      echo "Invalid option: -${OPTARG}."
      echo
      usage
      ;;
  esac
done

if [ $OPTCOUNT -lt 5 ]; then
      echo "Invalid options"
      echo
      usage
fi

IPARAM=""

case $MODE in
    "udp")
        IPARAM="-u -b $MAXRATE"
        ;;
    "tcp")
        ;;
    *)
        echo "Invalid mode option. Please specify udp or tcp"
        echo
        usage
        ;;
esac

SPYDUR=$(($DURATION))
DURATION=$(($DURATION+5))

function do_iperf() {

    echo "Traffic $MODE-$DIRECTION"
    echo

    echo "Starting mmnlspy for $spydur seconds..."
    mmnlspy -i $INTERFACE -r 1000 -fk -w 5000 -t $SPYDUR > $DATASETNAME-$DIRECTION-$MODE.spy &

    echo "Resetting stats"
    morse_cli -i $INTERFACE stats -r

    echo "Starting iperf for $DURATION seconds..."
    iperf3 -c $SERVER -p $PORT -fk -t $DURATION  $IPARAM $DIR --forceflush | tee -a $DATASETNAME-$DIRECTION-$MODE.iperf

    echo "Collecting station dump information..."
    iw $INTERFACE station dump > $DATASETNAME-$DIRECTION-$MODE.iw

    echo "Collecting stats"
    morse_cli -i $INTERFACE stats > $DATASETNAME-$DIRECTION-$MODE.stats

    echo "Waiting for processes to end..."
    echo
    sleep 5
}


case $DIRECTION in
    "up")
        DIR=""
        do_iperf
        ;;
    "down")
        DIR="-R"
        do_iperf
        ;;
    *)
        DIRECTION="up"
        DIR=""
        do_iperf
        DIRECTION="down"
        DIR="-R"
        do_iperf
        ;;
esac
