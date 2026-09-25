# Motion Live V2

This branch changes Motion Cam from a phone-first camera PWA into a desktop live-visual console.

## Philosophy

The controller/HUD and the audience video are different windows. The controller owns camera capture, effect selection and performance monitoring. The audience window receives only processed frames and contains no controls or overlays.

## Main changes

- Select any `videoinput` exposed by the browser instead of only front/rear facing mode.
- Enumerate desktop displays through the Window Management API when supported and open/move a clean output window to the selected monitor/projector.
- Press `F` or double-click the audience window to enter fullscreen.
- Keep a single in-flight processing frame. Frames are skipped rather than queued, so temporary overload increases dropped frames instead of live latency.
- Gate processing independently from the camera callback to hold the requested target FPS when the camera can supply it.
- Report measured output FPS, OpenCV processing time, frame-budget utilization, skipped scheduling slots and camera FPS.
- Smooth effect changes without computing two effects at once. The worker snapshots the exact currently displayed frame and blends it to the new live effect with a time-based smootherstep curve that reaches exactly 100%, avoiding an end-of-transition snap.
- `sminchia-bit` and `sminchia-bit colori` are included alongside Il Precursore and LSD Silver Surfer. Their discrete mode selectors (`bitMode` / `colorMode`) use the same visual crossfade instead of numerically stepping through intermediate modes.
- Smooth numeric effect parameters using the same transition duration.
- Allow 480/640/960/1280 px processing widths so performance can be traded for projector quality explicitly.
- The HUD preview can be disabled to remove an unnecessary canvas draw during a performance.

## Browser notes

Multi-display enumeration/placement works best in desktop Chromium browsers (Chrome/Edge) and requires the browser's multi-screen permission. If the API is unavailable, Motion Live still opens a clean output window; move it to the projector manually and press `F` there.

Camera permissions are required before browsers expose meaningful camera names.

## Performance model

There is deliberately no frame queue:

```text
camera -> latest due frame -> one worker job -> processed frame -> HUD preview (optional)
                                                    |
                                                    +-> clean output window
```

If the worker is still busy at the next frame deadline, that slot is skipped. This is preferable to accumulating latency in a live audience context.

## Smooth transitions

Effect changes use a live recursive crossfade so motion remains live and the last transition frame exactly matches the target.


## Smooth transitions

Effect and discrete-mode changes now use a **true live A/B crossfade**. During the transition, both the outgoing effect and the incoming effect are evaluated from the current camera frame, then mixed with a time-based smootherstep curve. This prevents the outgoing image from freezing during long transitions and reaches the incoming live stream exactly at the end, avoiding an end-of-fade snap.

This intentionally costs more CPU only while a transition is active (up to roughly two effect evaluations per processed frame). Outside a transition, only the selected effect is evaluated. The scheduler still keeps at most one camera frame in flight, so overload causes frame drops instead of latency buildup.
