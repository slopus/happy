"""Time of the first frame that differs from the one before it after t_min."""
from load import frames
import numpy as np, sys
t, a = frames(sys.argv[1])
tmin = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
for i in range(1, len(a)):
    if t[i] > tmin and np.abs(a[i] - a[i - 1])[150:].mean() > 1.0:
        print('%.4f' % t[i - 1])
        break
