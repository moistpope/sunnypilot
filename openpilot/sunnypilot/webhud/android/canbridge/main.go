// canbridge: receive-only SocketCAN forwarder for the HUD's live car-state read-out. It opens the
// given interfaces read-only, keeps only the listed CAN IDs (kernel CAN_RAW filters), and prints each
// frame whose payload changed as "<iface> <id-hex> <data-hex>" on stdout. It NEVER transmits: there is
// no write path anywhere in this program, and it does not create any writable socket option.
//
//	canbridge can1=234,2F5,335 can2=236,321
//
// A line "# ready" is printed once both sockets are bound. Stdin closing (the parent going away) ends it.
package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	afCAN   = 29
	canRAW   = 1
	solCANRAW = 101
	effFlag = 0x80000000
	errFlag = 0x20000000
	rtrFlag = 0x40000000
)

type sockaddrCAN struct {
	Family  uint16
	_       uint16
	Ifindex int32
	Addr    [16]byte
}

type filter struct {
	ID   uint32
	Mask uint32
}

// openRead binds a raw CAN socket to iface, accepting only the given IDs. Read-only: the socket is set
// non-blocking for the poll loop; no transmit option is ever set.
func openRead(iface string, ids []uint32) (int, error) {
	fd, err := syscall.Socket(afCAN, syscall.SOCK_RAW, canRAW)
	if err != nil {
		return -1, fmt.Errorf("socket: %w", err)
	}
	ifi, err := net.InterfaceByName(iface)
	if err != nil {
		return -1, fmt.Errorf("interface %s: %w", iface, err)
	}
	if len(ids) > 0 {
		filters := make([]filter, len(ids))
		for i, id := range ids {
			filters[i] = filter{ID: id, Mask: 0x7FF}
		}
		_, _, e := syscall.Syscall6(syscall.SYS_SETSOCKOPT, uintptr(fd), solCANRAW, 1, /* SOL_CAN_RAW, CAN_RAW_FILTER */
			uintptr(unsafe.Pointer(&filters[0])), unsafe.Sizeof(filters[0])*uintptr(len(filters)), 0)
		if e != 0 {
			return -1, fmt.Errorf("set filter on %s: %v", iface, e)
		}
	}
	_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, 33 /* SO_RCVBUFFORCE */, 4<<20)
	sa := sockaddrCAN{Family: afCAN, Ifindex: int32(ifi.Index)}
	if _, _, e := syscall.Syscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa)); e != 0 {
		return -1, fmt.Errorf("bind %s: %v", iface, e)
	}
	return fd, nil
}

func main() {
	var ifaces [][2]string // iface, csv-ids
	for _, a := range os.Args[1:] {
		if i := strings.IndexByte(a, '='); i > 0 {
			ifaces = append(ifaces, [2]string{a[:i], a[i+1:]})
		}
	}
	if len(ifaces) == 0 {
		fmt.Fprintln(os.Stderr, "usage: canbridge can1=234,2F5 can2=236")
		os.Exit(2)
	}
	out := bufio.NewWriter(os.Stdout)
	var mu sync.Mutex
	fds := []int{}
	for _, spec := range ifaces {
		var ids []uint32
		for _, s := range strings.Split(spec[1], ",") {
			if s = strings.TrimSpace(s); s != "" {
				v, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(s), "0x"), 16, 32)
				if err == nil {
					ids = append(ids, uint32(v))
				}
			}
		}
		fd, err := openRead(spec[0], ids)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fds = append(fds, fd)
		iface := spec[0]
		last := map[uint32]string{}
		go func() {
			buf := make([]byte, 16)
			for {
				n, err := syscall.Read(fd, buf)
				if err != nil {
					if err == syscall.EINTR {
						continue
					}
					return
				}
				if n < 16 {
					continue
				}
				raw := uint32(buf[0]) | uint32(buf[1])<<8 | uint32(buf[2])<<16 | uint32(buf[3])<<24
				if raw&(errFlag|rtrFlag) != 0 || raw&effFlag != 0 {
					continue // only standard data frames
				}
				id := raw & 0x7FF
				dlc := int(buf[4])
				if dlc > 8 {
					dlc = 8
				}
				data := hex.EncodeToString(buf[8 : 8+dlc])
				mu.Lock()
				if last[id] != data { // forward only on change
					last[id] = data
					fmt.Fprintf(out, "%s %03X %s\n", iface, id, data)
					out.Flush()
				}
				mu.Unlock()
			}
		}()
	}
	fmt.Fprintln(out, "# ready")
	out.Flush()
	// end when the parent closes our stdin
	io := make([]byte, 64)
	for {
		if _, err := os.Stdin.Read(io); err != nil {
			break
		}
	}
	for _, fd := range fds {
		syscall.Close(fd)
	}
}
