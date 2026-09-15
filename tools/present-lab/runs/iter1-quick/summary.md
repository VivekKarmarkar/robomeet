| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |
|---|---|---|---|---|---|---|---|---|
| old-720_VP9_1200k | 320x180 | 0.8493 | 20.093862 | 30.7 | bandwidth | - | 118 ms / 28 fps |  |
| old-1080_VP9_1200k | 640x360 | 0.8843 | 21.400249 | 34.7 | bandwidth | - | 91 ms / 27 fps |  |
| new-exact_VP9_1200k | 1920x1080 | 0.9989 | 51.858980 | 124 | none | detail | 362 ms / 8 fps |  |
| new-page_VP9_1200k | 1920x1080 | 0.984 | 28.103525 | 127.6 | none | detail | 329 ms / 8 fps |  |
