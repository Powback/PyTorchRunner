#!/usr/bin/env python3
"""Slow streaming test - 3 second job with output every second"""
import time
import sys

print("Starting slow job...", flush=True)
for i in range(6):
    time.sleep(0.5)
    print(f"Progress {i+1}/6", flush=True)
    sys.stderr.write(f"[stderr] checkpoint {i+1}\n")
    sys.stderr.flush()
print("Done!", flush=True)
