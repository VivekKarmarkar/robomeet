| scenario | received | SSIM-Y | PSNR-Y | avg QP | limit | hint | change latency / fps | error |
|---|---|---|---|---|---|---|---|---|
| old-720_VP9_2500k | 480x270 | 0.8501 | 20.093139 | 34.7 | bandwidth | - | 85 ms / 30 fps |  |
| old-1080_VP9_2500k | 480x270 | 0.8792 | 21.209403 | 35.1 | bandwidth | - | 109 ms / 29 fps |  |
| new-exact_VP9_2500k | 1920x1080 | 0.9989 | 51.964917 | 94.3 | none | detail | 169 ms / 8 fps |  |
| new-page_VP9_2500k | 1920x1080 | 0.9841 | 28.105907 | 98.8 | none | detail | 190 ms / 9 fps |  |
| old-720_VP9_800k | 640x360 | 0.8551 | 20.244917 | 39 | bandwidth | - |  |  |
| old-1080_VP9_800k | 640x360 | 0.8855 | 21.421448 | 39.3 | bandwidth | - |  |  |
| new-exact_VP9_800k | 1920x1080 | 0.999 | 52.080071 | 103.6 | none | detail |  |  |
| new-page_VP9_800k | 1920x1080 | 0.9841 | 28.107608 | 127.1 | none | detail |  |  |
| old-720_VP8_2500k | 480x270 | 0.8497 | 20.087383 | 4.5 | bandwidth | - |  |  |
| old-1080_VP8_2500k | 480x270 | 0.8785 | 21.193740 | 4.6 | bandwidth | - |  |  |
| new-exact_VP8_2500k | 1920x1080 | 0.9992 | 52.358600 | 38.9 | none | detail |  |  |
| new-page_VP8_2500k | 1920x1080 | 0.9844 | 28.111582 | 35.1 | none | detail |  |  |
| old-720_VP8_800k | 480x270 | 0.8503 | 20.093653 | 7.4 | bandwidth | - |  |  |
| old-1080_VP8_800k | 480x270 | 0.8793 | 21.207716 | 7.9 | bandwidth | - |  |  |
| new-exact_VP8_800k | 1920x1080 | 0.9991 | 50.635473 | 55.3 | none | detail |  |  |
| new-page_VP8_800k | 1920x1080 | 0.9844 | 28.101064 | 53.1 | none | detail |  |  |
| old-720_AV1_2500k | 480x270 | 0.8492 | 20.081351 | 56.5 | bandwidth | - |  |  |
| old-1080_AV1_2500k | 480x270 | 0.8783 | 21.189135 | 56 | bandwidth | - |  |  |
| new-exact_AV1_2500k | 1920x1080 | 0.9994 | 51.663287 | 96.8 | none | detail |  |  |
| new-page_AV1_2500k | 1920x1080 | 0.9844 | 28.103171 | 101.9 | none | detail |  |  |
| old-720_AV1_800k | 480x270 | 0.8489 | 20.074859 | 58.7 | bandwidth | - |  |  |
| old-1080_AV1_800k | 480x270 | 0.8776 | 21.192323 | 59.9 | bandwidth | - |  |  |
| new-exact_AV1_800k | 1920x1080 | 0.9992 | 51.544691 | 125.5 | none | detail |  |  |
| new-page_AV1_800k | 1920x1080 | 0.9844 | 28.103779 | 99.5 | none | detail |  |  |
| new-exact_VP9_800k_hint-none | 480x270 | 0.8975 | 22.053458 | 55.4 | bandwidth | - |  |  |
| new-exact_VP9_800k_hint-motion | 480x270 | 0.8975 | 22.053787 | 51.3 | bandwidth | motion |  |  |
| new-exact_VP9_800k_hint-detail | 1920x1080 | 0.9989 | 52.023606 | 115.4 | none | detail |  |  |
| new-exact_VP9_800k_hint-text | 1920x1080 | 0.9989 | 52.069990 | 105.4 | none | text |  |  |
| new-exact_VP9_800k_idle33 | 1920x1080 | 0.9989 | 52.064147 | 117.5 | none | detail |  |  |
| new-exact_VP9_800k_idle100 | 1920x1080 | 0.9989 | 52.006230 | 120.1 | none | detail |  |  |
| new-exact_VP9_800k_idle250 | 1920x1080 | 0.9972 | 48.250792 | 158.8 | none | detail |  |  |
