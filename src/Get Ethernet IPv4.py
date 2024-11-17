import socket
import time

hostname = socket.gethostname()
ip_address = socket.gethostbyname(hostname)

print(f"Ethernet IPv4 Address: {ip_address}")
time.sleep(10)