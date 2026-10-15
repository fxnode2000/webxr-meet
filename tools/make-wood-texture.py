# Seamless, neutral wood grain tile (greyscale-warm, mean ~0.88) used for every wood surface in kitchen.glb.
# Grain runs along the vertical axis (v). Each wood face is tinted by its own vertex colour.
# Deterministic: same seed, same texture. Needs numpy and Pillow.  python make_wood.py out.png [size]
import sys, numpy as np
from PIL import Image
N = int(sys.argv[2]) if len(sys.argv) > 2 else 2048
rng = np.random.default_rng(20261015)
fx = np.fft.fftfreq(N)[None, :] * N   # cycles per tile across (x)
fy = np.fft.fftfreq(N)[:, None] * N   # cycles per tile along (y)

def aniso_noise(cx, cy, seed):
    """Periodic noise: gaussian low-pass in frequency; cx = detail across the grain, cy = detail along it."""
    r = np.random.default_rng(seed)
    w = r.standard_normal((N, N))
    H = np.exp(-((fx / cx) ** 2 + (fy / cy) ** 2))
    n = np.fft.ifft2(np.fft.fft2(w) * H).real
    return (n - n.mean()) / (n.std() + 1e-9)

x = np.arange(N)[None, :] / N
y = np.arange(N)[:, None] / N

fibres = aniso_noise(260, 5, 1)              # fine fibres running along the board
fibres2 = aniso_noise(90, 3, 2)              # coarser streaks
warp = aniso_noise(2.5, 2.5, 3)              # low-frequency wobble of the growth rings
mott = aniso_noise(4, 4, 4)                  # slow large-scale mottling
ringmod = aniso_noise(3, 3, 5)
pores_n = aniso_noise(220, 40, 6)            # short dark dashes (pores)

rings_count = 26
v = x * rings_count + 0.22 * warp + 0.10 * aniso_noise(10, 6, 7)   # x is periodic and rings_count is an integer: tiles cleanly
ring = np.abs(np.sin(np.pi * v))
ring = ring ** 3.0                            # thin dark late-wood lines
ring_strength = 0.55 + 0.35 * np.tanh(ringmod)

pores = np.clip(pores_n - 1.6, 0, None)       # sparse
pores = np.clip(pores / 1.5, 0, 1)

g = (0.34 * fibres + 0.22 * fibres2 + 0.05 * mott)
L = 0.90 + 0.095 * g - 0.20 * ring * ring_strength - 0.16 * pores
L = np.clip(L, 0.30, 1.0)
# keep the average at ~0.88 so vertex colours of at most 1 can reproduce light tones
L = np.clip(L * (0.88 / L.mean()), 0.0, 1.0)
rgb = np.stack([L * 1.0, L * 0.965, L * 0.915], axis=-1)   # faint warmth; real colour comes from vertex colours
img = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
img.save(sys.argv[1], quality=95) if sys.argv[1].lower().endswith(('.jpg', '.jpeg')) else img.save(sys.argv[1])
print('mean', float(L.mean()), 'min', float(L.min()), 'std', float(L.std()))
# tile-seam check: difference across the wrap vs a normal neighbour step
d_wrap = float(np.abs(rgb[:, 0] - rgb[:, -1]).mean()); d_in = float(np.abs(rgb[:, 1] - rgb[:, 0]).mean())
e_wrap = float(np.abs(rgb[0] - rgb[-1]).mean()); e_in = float(np.abs(rgb[1] - rgb[0]).mean())
print('seam x', d_wrap, 'vs', d_in, ' seam y', e_wrap, 'vs', e_in)
