"""Synthetic DNS only inside the disposable Linux sandbox harness."""
import socket
import struct

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(('127.0.0.1', 5353))
while True:
    query, peer = server.recvfrom(4096)
    end = 12
    labels = []
    while query[end]:
        size = query[end]
        labels.append(query[end + 1:end + 1 + size])
        end += size + 1
    end += 1
    kind, _ = struct.unpack('!HH', query[end:end + 4])
    approved = b'.'.join(labels).endswith(b'.unapproved.test')
    answer = b''
    if approved and kind == 1:
        answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 0, 4) + socket.inet_aton('8.8.4.4')
    response = query[:2] + struct.pack('!HHHHH', 0x8180 if approved else 0x8183, 1, bool(answer), 0, 0)
    server.sendto(response + query[12:end + 4] + answer, peer)
