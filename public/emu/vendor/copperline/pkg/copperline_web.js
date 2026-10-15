/* @ts-self-types="./copperline_web.d.ts" */

export class WebEmu {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WebEmuFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_webemu_free(ptr, 0);
    }
    /**
     * Queued audio frames not yet drained (diagnostics).
     * @returns {number}
     */
    audio_pending() {
        const ret = wasm.webemu_audio_pending(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Identify this build for bug reports: the tag or branch and commit the
     * wasm was compiled from. GitHub Actions exports GITHUB_REF_NAME and
     * GITHUB_SHA to every step, so the publish workflow bakes them in for
     * free; anything built outside CI reports itself as a dev build.
     * @returns {string}
     */
    static build_info() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.webemu_build_info();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The Caps Lock LED, owned by the keyboard MCU: pressing the key
     * toggles it, and the up code is what unlocking sends. A page lighting
     * a virtual Caps Lock key must read this rather than mirror its own
     * taps, or a save-state load leaves the two disagreeing.
     * @returns {boolean}
     */
    caps_lock_led() {
        const ret = wasm.webemu_caps_lock_led(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * CD activity LED, or undefined on machines without a CD drive.
     * @returns {boolean | undefined}
     */
    cd_led() {
        const ret = wasm.webemu_cd_led(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
     * Whether motion-adaptive LACE field merging is enabled.
     * @returns {boolean}
     */
    deinterlace_enabled() {
        const ret = wasm.webemu_deinterlace_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * File name of the image in DFn, or undefined when the drive is
     * empty (so this doubles as the inserted check).
     * @param {number} drive
     * @returns {string | undefined}
     */
    disk_name(drive) {
        const ret = wasm.webemu_disk_name(this.__wbg_ptr, drive);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Whether DFn is wired up. CDTV/CD32 start with none; other profiles
     * start with DF0, and an explicit constructor count overrides either.
     * @param {number} drive
     * @returns {boolean}
     */
    drive_connected(drive) {
        const ret = wasm.webemu_drive_connected(this.__wbg_ptr, drive);
        return ret !== 0;
    }
    /**
     * @param {number} drive
     */
    eject_floppy(drive) {
        const ret = wasm.webemu_eject_floppy(this.__wbg_ptr, drive);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    emulated_seconds() {
        const ret = wasm.webemu_emulated_seconds(this.__wbg_ptr);
        return ret;
    }
    /**
     * Snapshot DFn's current image bytes. Standard disks export as ADF and
     * track images as UAE extended ADF; compressed inputs export decoded.
     * @param {number} drive
     * @returns {Uint8Array}
     */
    export_floppy(drive) {
        const ret = wasm.webemu_export_floppy(this.__wbg_ptr, drive);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Floppy activity LED: lit while any drive's motor runs.
     * @returns {boolean}
     */
    fdd_led() {
        const ret = wasm.webemu_fdd_led(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Cylinder under the selected floppy drive's head, or undefined when
     * no drive is selected. The page latches the last value so a track
     * counter does not flicker between accesses, like the desktop bar.
     * @returns {number | undefined}
     */
    fdd_track() {
        const ret = wasm.webemu_fdd_track(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * The floppy image file extensions this build can open, without their
     * dots ("adf", "ipf", ...), straight from the core's own list.
     *
     * [`WebEmu::insert_floppy`] decides by signature and never looks at the
     * name, but a file picker cannot sniff: `<input type="file" accept=...>`
     * hides everything it does not list, so a filter naming fewer formats
     * than the core reads locks a visitor out of images this build would
     * have loaded. The page fills the picker (and the `#df0list` folder
     * filter) from here so the two cannot drift apart. Like `models`, its
     * presence is also the feature test for older bundles.
     * @returns {string[]}
     */
    static floppy_formats() {
        const ret = wasm.webemu_floppy_formats();
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Current floppy drive speed value (percentage, or 0 for turbo).
     * @returns {number}
     */
    floppy_speed() {
        const ret = wasm.webemu_floppy_speed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Whether DFn's inserted image is write-protected, or undefined when
     * empty. A writable browser image remains in memory until exported.
     * @param {number} drive
     * @returns {boolean | undefined}
     */
    floppy_write_protected(drive) {
        const ret = wasm.webemu_floppy_write_protected(this.__wbg_ptr, drive);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
     * Hard-disk activity LED, or undefined on machines without a disk
     * controller (the page hides the LED).
     * @returns {boolean | undefined}
     */
    hdd_led() {
        const ret = wasm.webemu_hdd_led(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret !== 0;
    }
    /**
     * Insert a floppy image from bytes: every format the core reads
     * (ADF/ADZ, extended ADF, DMS, IPF, SCP, optionally gzip/zip-packed),
     * recognised by signature rather than by name. Always write-protected;
     * use `insert_floppy_writable` when the page will offer an export.
     * @param {number} drive
     * @param {Uint8Array} bytes
     * @param {string} name
     */
    insert_floppy(drive, bytes, name) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_insert_floppy(this.__wbg_ptr, drive, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Insert an uncompressed standard or UAE extended ADF with a writable,
     * in-memory backing. Guest writes stay in the machine (and its save
     * states) until the page calls `export_floppy`; no browser filesystem is
     * involved. Compressed containers, DMS, IPF and SCP throw because their
     * decoded representation cannot be written back in the original format.
     * @param {number} drive
     * @param {Uint8Array} bytes
     * @param {string} name
     */
    insert_floppy_writable(drive, bytes, name) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_insert_floppy_writable(this.__wbg_ptr, drive, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Forward a keyboard event; `code` is `KeyboardEvent.code`. Returns
     * true when the key maps to an Amiga key (the page then calls
     * preventDefault).
     * @param {string} code
     * @param {boolean} pressed
     * @returns {boolean}
     */
    key_event(code, pressed) {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_key_event(this.__wbg_ptr, ptr0, len0, pressed);
        return ret !== 0;
    }
    /**
     * Forward an Amiga raw key transition to the keyboard MCU, or update the
     * held keys sampled by the rollback timeline during netplay.
     * The page's on-screen keyboard draws Amiga keys, so its keys already
     * are rawkeys and a `KeyboardEvent.code` round trip would be a lossy
     * detour: $2B, the key beside Return on an ISO Amiga keyboard, has no
     * positional code a browser reports on every host layout, and the
     * reverse table would have to be duplicated in the page glue.
     * @param {number} rawkey
     * @param {boolean} pressed
     */
    key_raw(rawkey, pressed) {
        wasm.webemu_key_raw(this.__wbg_ptr, rawkey, pressed);
    }
    /**
     * Host milliseconds spent advancing the emulated machine in the most
     * recent `run`/`run_hidden` call, excluding the Rust presentation
     * renderer.
     * @returns {number}
     */
    last_run_core_ms() {
        const ret = wasm.webemu_last_run_core_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * Host milliseconds spent in the Rust presentation renderer in the most
     * recent `run` call. `run_hidden`, an idle run, and a call that needed no
     * repaint report zero.
     * @returns {number}
     */
    last_run_render_ms() {
        const ret = wasm.webemu_last_run_render_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * Fit a Kickstart/AROS ROM (and optional extended ROM) from bytes and
     * cold-reset, as if the chips had been swapped and the machine power
     * cycled. 256 KiB Kickstart 1.x images are mirrored up automatically.
     * @param {Uint8Array} rom
     * @param {Uint8Array | null} [ext]
     */
    load_rom(rom, ext) {
        const ptr0 = passArray8ToWasm0(rom, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(ext) ? 0 : passArray8ToWasm0(ext, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_load_rom(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Restore a state produced by `save_state` (or by a desktop build).
     * The machine rebuilds from the blob, so the fitted ROM and inserted
     * disks come back with it. A blob that is not a readable state of this
     * build's format version throws and leaves the running machine
     * untouched, so a page can offer a load without risking the session.
     *
     * Host-side settings do not travel with the state (they are not part of
     * the machine): a page that keeps its own volume, drive-sound or floppy
     * speed choices should re-apply them after a load.
     * @param {Uint8Array} blob
     */
    load_state(blob) {
        const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_load_state(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The running machine's profile name ("A500", "A1200", ...), or
     * undefined for a machine no profile describes -- the model-less
     * default constructor's machine, or a custom-shaped machine restored
     * from a save state. Follows `load_state`, so a page can re-point its
     * machine select at what a state brought back.
     * @returns {string | undefined}
     */
    machine_model() {
        const ret = wasm.webemu_machine_model(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * One-line description of the running machine for bug reports and
     * diagnostics: profile, CPU, chipset, RAM sizes, and the fitted ROM's
     * fingerprint. Tracks ROM swaps and state loads.
     * @returns {string}
     */
    machine_summary() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.webemu_machine_summary(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The machine profiles the page's machine select offers, in menu
     * order. A vetted subset of what the constructor accepts: every model
     * here boots the bundled AROS ROM (or a plain Kickstart) with nothing
     * but a floppy, so the page can offer it unconditionally. The page
     * builds its select from this list, which is also its feature test --
     * older bundles have no `models` and the select stays hidden.
     * @returns {string[]}
     */
    static models() {
        const ret = wasm.webemu_models();
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Mouse buttons: 0 = left, 1 = middle, 2 = right (MouseEvent.button).
     * @param {number} button
     * @param {boolean} pressed
     */
    mouse_button(button, pressed) {
        wasm.webemu_mouse_button(this.__wbg_ptr, button, pressed);
    }
    /**
     * Relative mouse motion in emulated hi-res pixels (pointer-lock
     * movementX/Y, or scaled cursor deltas when unlocked).
     * @param {number} dx
     * @param {number} dy
     */
    mouse_delta(dx, dy) {
        wasm.webemu_mouse_delta(this.__wbg_ptr, dx, dy);
    }
    netplay_apply_disk() {
        const ret = wasm.webemu_netplay_apply_disk(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Retain the confirmed history so spectators can join, even late. Call
     * right after `start_netplay`, before the first run.
     */
    netplay_enable_spectators() {
        const ret = wasm.webemu_netplay_enable_spectators(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Freeze at the current frame while the reliable channel negotiates a
     * common boundary. Input packets continue to reconcile and acknowledge.
     * @returns {number}
     */
    netplay_hold() {
        const ret = wasm.webemu_netplay_hold(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * The initial machine fingerprint every spectator must reproduce.
     * @returns {Uint8Array}
     */
    netplay_identity() {
        const ret = wasm.webemu_netplay_identity(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * [protocol version, maximum packet bytes, header bytes, input record bytes].
     * @returns {Uint32Array}
     */
    static netplay_packet_layout() {
        const ret = wasm.webemu_netplay_packet_layout();
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {Uint8Array} packet
     */
    netplay_receive(packet) {
        const ptr0 = passArray8ToWasm0(packet, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_netplay_receive(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Release this peer's held keys/controller without touching the guest directly.
     */
    netplay_release_input() {
        wasm.webemu_netplay_release_input(this.__wbg_ptr);
    }
    netplay_resume() {
        const ret = wasm.webemu_netplay_resume(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} drive
     * @param {Uint8Array} bytes
     * @param {boolean} writable
     */
    netplay_stage_disk(drive, bytes, writable) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_netplay_stage_disk(this.__wbg_ptr, drive, ptr0, len0, writable);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * [connected, frame, confirmed, acknowledged, rollbacks, replayed, checked].
     * Counters are exact JavaScript numbers for any practical session duration.
     * @returns {Float64Array}
     */
    netplay_status() {
        const ret = wasm.webemu_netplay_status(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Both stopped peers catch up to the greater of their two frame numbers.
     * @param {number} frame
     */
    netplay_stop_at(frame) {
        const ret = wasm.webemu_netplay_stop_at(this.__wbg_ptr, frame);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Digests before and after the change are compared over the reliable
     * channel; neither peer resumes on a mismatch.
     * @returns {Uint8Array}
     */
    netplay_swap_digest() {
        const ret = wasm.webemu_netplay_swap_digest(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    netplay_swap_ready() {
        const ret = wasm.webemu_netplay_swap_ready(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Empty means there is no outgoing packet. Drain after every run call.
     * @returns {Uint8Array}
     */
    netplay_take_packet() {
        const ret = wasm.webemu_netplay_take_packet(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Validate an image without touching the live drive. Empty bytes mean eject.
     * @param {number} drive
     * @param {Uint8Array} bytes
     * @param {boolean} writable
     */
    netplay_validate_disk(drive, bytes, writable) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_netplay_validate_disk(this.__wbg_ptr, drive, ptr0, len0, writable);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Build a machine with a placeholder ROM; `load_rom` supplies the real
     * one. `model` picks the machine profile by name ("A500", "A1200", ...)
     * exactly as the desktop's `--model` flag does; omitted or empty, the
     * default machine is the A500 of the desktop launcher, so pages built
     * against the model-less constructor keep booting what they always did.
     * `models` lists the profiles the hosted page offers; any name the
     * desktop flag takes is accepted here, but the ones outside that list
     * may need pieces a browser page cannot supply (CDTV/CD32 want an
     * extended ROM and a CD). An unknown name throws.
     *
     * `video` picks the video standard ("PAL" or "NTSC", the desktop's
     * `[chipset] video` key) on top of whatever the profile chose; omitted
     * or empty keeps the profile's own standard (PAL for every offered
     * profile). `floppy_drives` fits zero to four drives, matching the
     * desktop's `[floppy] drives` setting; omitted, the profile default stays
     * in place (zero for CDTV/CD32, one for the other profiles). An unknown
     * name or invalid drive count throws.
     * @param {string | null} [model]
     * @param {string | null} [video]
     * @param {number | null} [floppy_drives]
     */
    constructor(model, video, floppy_drives) {
        var ptr0 = isLikeNone(model) ? 0 : passStringToWasm0(model, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(video) ? 0 : passStringToWasm0(video, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_new(ptr0, len0, ptr1, len1, !isLikeNone(floppy_drives), isLikeNone(floppy_drives) ? 0 : floppy_drives);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WebEmuFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The quantised CRT phosphor-persistence fraction currently in use.
     * @returns {number}
     */
    phosphor() {
        const ret = wasm.webemu_phosphor(this.__wbg_ptr);
        return ret;
    }
    /**
     * Power LED brightness: true while the guest holds CIA-A's /LED line
     * engaged (full brightness, Paula's filter on), false once it releases
     * it -- the page then shows the dimmed A500 rev 6+ level, never an
     * unlit LED, as a running machine is always powered. The front-panel
     * getters below are cheap enough to poll once per animation frame.
     * @returns {boolean}
     */
    power_led() {
        const ret = wasm.webemu_power_led(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The latched autocrop envelope in presentation-buffer pixels, as
     * `[x, y, width, height]`, or empty while no content has been seen
     * since the last presentation discontinuity. Tracked whether or not
     * autocrop is on (it is what `present_layout` crops to), and it can
     * change between frames like `present_width`: it grows at once when
     * a program opens a larger display and tightens only after a smaller
     * one has held steady for about half a second.
     * @returns {Uint32Array}
     */
    present_content_rect() {
        const ret = wasm.webemu_present_content_rect(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Emulated field lines the presentation buffer shows, for a page-side
     * CRT shader pass to key its scanline pitch: 270 on the standard 50 Hz
     * TV aperture, 214 on a 60 Hz scan (285 and 235 under the tube
     * aperture of a drawn bezel), half the presented rows in full
     * overscan. 0 means the pass has nothing to draw -- no frame yet, or a
     * programmable scan, whose lines are not a 15 kHz raster (the desktop
     * suspends its CRT preset there too). Tracks the presentation, so it
     * can change between frames like `present_width`.
     * @returns {number}
     */
    present_crt_lines() {
        const ret = wasm.webemu_present_crt_lines(this.__wbg_ptr);
        return ret;
    }
    /**
     * Where the presentation buffer lands on an `avail_w` x `avail_h`
     * device-pixel viewport under the scaling and autocrop settings, for
     * a page that draws the buffer itself: `[sx, sy, sw, sh, dx, dy, dw,
     * dh, columns, lines]` -- the buffer sub-rect to show (the autocrop
     * envelope, or the whole buffer), where to draw it (the viewport
     * outside it is black), and the whole-number factors of an integer
     * draw as device pixels per native pixel and per scan line (0, 0
     * for a smooth fit). Empty until a frame has been presented.
     *
     * The buffer's pixel shape is the 4:3 glass's, retained from the
     * scan aperture when Smart autocrop uses the complete raster: drawn
     * smooth, the whole buffer fills such a viewport exactly as the
     * page's stretch does, and a crop keeps that shape in a letterbox;
     * drawn integer, a standard scan takes a whole number per axis
     * approximating that shape -- the desktop's per-axis fit, 4:5 pixels
     * for a 200-line NTSC game on a 1080p screen -- and a programmable
     * scan the uniform multiple. The page decides when to ask: the
     * hosted page keeps its plain stretch while both settings are off,
     * and while a bezel mode's fixed opening owns the glass.
     * @param {number} avail_w
     * @param {number} avail_h
     * @returns {Uint32Array}
     */
    present_layout(avail_w, avail_h) {
        const ret = wasm.webemu_present_layout(this.__wbg_ptr, avail_w, avail_h);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Presentation buffer: RGBA bytes in memory order, `present_width() x
     * present_rows()` pixels, directly viewable as canvas ImageData. The
     * pointer is only valid until the next `run` call (the buffer may
     * reallocate and wasm memory may grow), so JS must re-create its view
     * every frame.
     * @returns {number}
     */
    present_ptr() {
        const ret = wasm.webemu_present_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Rows of the presentation buffer. The 50 Hz TV aperture's row count
     * for a standard scan under the default smooth scaling (a 60 Hz
     * aperture is resampled onto it, so both fill the same 4:3 glass),
     * the aperture's own woven rows under integer scaling (see
     * `set_scaling`), the whole field's rows in full overscan.
     * @returns {number}
     */
    present_rows() {
        const ret = wasm.webemu_present_rows(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Width of the presentation buffer in pixels. The captured TV aperture
     * for standard 15 kHz displays (PAL and NTSC alike), the full
     * framebuffer width otherwise; it can change between frames, so JS must
     * size the canvas from it each frame alongside `present_rows`.
     * @returns {number}
     */
    present_width() {
        const ret = wasm.webemu_present_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Generation of the current presentation buffer. It advances when the
     * renderer writes a non-reused presentation, not merely because the
     * emulated machine stepped, so a browser can skip exact-reuse canvas
     * uploads and draws without comparing the framebuffer itself.
     * @returns {number}
     */
    presentation_revision() {
        const ret = wasm.webemu_presentation_revision(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Cold reset (power cycle), keeping the fitted ROM and inserted disks.
     */
    reset() {
        const ret = wasm.webemu_reset(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Forget the wall-clock/emulated-time pairing, so the next `run` starts
     * pacing from now instead of trying to make up the gap. A page calls
     * this when resuming from a pause: without it the first tick after the
     * pause sees a wall clock that ran on while the guest did not, and
     * sprints through frames until the catch-up clamp trips.
     */
    resync_clock() {
        wasm.webemu_resync_clock(this.__wbg_ptr);
    }
    /**
     * Step emulated time up to the wall clock (`now_ms` is
     * `performance.now()`), at most `max_frames` PAL frames per call, then
     * render the latest completed frame into the presentation buffer.
     * Returns the number of frames stepped. Deficits past 100 ms are
     * forgiven by re-anchoring, so a backgrounded tab resumes at real time
     * instead of fast-forwarding.
     * @param {number} now_ms
     * @param {number} max_frames
     * @returns {number}
     */
    run(now_ms, max_frames) {
        const ret = wasm.webemu_run(this.__wbg_ptr, now_ms, max_frames);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * `run` for a hidden page: step the machine and queue its audio, but
     * skip rendering the presentation buffer nobody can see. The first
     * rendering `run` after hidden stepping repaints even if it stepped
     * no frames itself, so a tab that kept running in the background
     * shows the current picture the moment it is visible again.
     * @param {number} now_ms
     * @param {number} max_frames
     * @returns {number}
     */
    run_hidden(now_ms, max_frames) {
        const ret = wasm.webemu_run_hidden(this.__wbg_ptr, now_ms, max_frames);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Snapshot the whole emulated machine (RAM, ROM, chipset, CPU, the
     * floppy images themselves) into a `.clstate` blob, the same format the
     * desktop builds write, so a state saved here loads there and back. The
     * page decides where it goes: a download, IndexedDB, anywhere it can
     * keep bytes. Call between frames -- outside `run`, which every
     * JS-facing method is by construction.
     * @returns {Uint8Array}
     */
    save_state() {
        const ret = wasm.webemu_save_state(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Whether the guest is asserting the serial port's DTR line (CIA-B PA7
     * driven low). A terminal raises DTR when it opens the port --
     * serial.device does it on OpenDevice, hardware-level terminals set the
     * CIA bit themselves -- and drops it on close and at reset, so this is
     * the "guest terminal is ready" signal a modem would key off. The page
     * bridge uses it to defer dialling until the terminal can actually
     * display the far end's greeting.
     * @returns {boolean}
     */
    serial_dtr() {
        const ret = wasm.webemu_serial_dtr(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Bytes queued by `serial_send` that the guest's UART has not yet
     * consumed. Flow control: stop reading the socket while this is large.
     * @returns {number}
     */
    serial_input_backlog() {
        const ret = wasm.webemu_serial_input_backlog(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Queue received bytes for Paula's serial receiver (the page's
     * socket -> the guest). The queue is unbounded and the UART consumes it
     * at the emulated baud rate, so pace large transfers with
     * `serial_input_backlog` instead of pushing megabytes at once.
     * @param {Uint8Array} bytes
     */
    serial_send(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.webemu_serial_send(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Raise or drop the serial port's carrier-detect input (CIA-B PA5, /CD)
     * as the page's far end connects and hangs up. The bridge always
     * presents itself as a present, ready device (DSR and CTS asserted);
     * carrier is the one line a byte-stream bridge knows the state of, and
     * it is what a guest terminal or BBS watches to notice a hang-up. Call
     * with `true` when the socket opens and `false` when it closes; a page
     * that never calls it leaves the guest seeing a modem with no call up.
     * @param {boolean} connected
     */
    serial_set_carrier(connected) {
        wasm.webemu_serial_set_carrier(this.__wbg_ptr, connected);
    }
    /**
     * Drain everything the guest transmitted on the serial port since the
     * last call (the guest -> the page's socket). Call once per animation
     * frame, like `take_audio`; output is bounded, and anything a
     * non-draining page lets pile up past that bound is dropped oldest
     * first. This also carries boot-ROM/OS debug output, so a page may log
     * it even with no socket connected.
     * @returns {Uint8Array}
     */
    serial_take() {
        const ret = wasm.webemu_serial_take(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The desktop's `[display] autocrop` (default off): `present_layout`
     * crops the presentation to the display window the hardware actually
     * programs -- the rows and columns that carry fetched bitplane data,
     * smoothed across frames exactly as the desktop smooths its crop --
     * instead of the fixed TV aperture, so a 200-line game fills far
     * more of a 16:9 screen, and under integer scaling earns the larger
     * whole multiple the cropped picture fits. Smart framing also rebuilds
     * the source from the complete raster, before the fixed TV aperture
     * clips it. Other framing modes change only the layout.
     * @param {boolean} autocrop
     */
    set_autocrop(autocrop) {
        wasm.webemu_set_autocrop(this.__wbg_ptr, autocrop);
    }
    /**
     * The CD32 pad's extra buttons on either port (red/blue arrive through
     * `set_joystick_port` as fire/button2).
     * @param {number} port
     * @param {boolean} play
     * @param {boolean} rwd
     * @param {boolean} ffw
     * @param {boolean} green
     * @param {boolean} yellow
     */
    set_cd32_buttons_port(port, play, rwd, ffw, green, yellow) {
        wasm.webemu_set_cd32_buttons_port(this.__wbg_ptr, port, play, rwd, ffw, green, yellow);
    }
    /**
     * Port-2 CD32 buttons. Superseded by `set_cd32_buttons_port`.
     * @param {boolean} play
     * @param {boolean} rwd
     * @param {boolean} ffw
     * @param {boolean} green
     * @param {boolean} yellow
     */
    set_cd32_buttons_port2(play, rwd, ffw, green, yellow) {
        wasm.webemu_set_cd32_buttons_port2(this.__wbg_ptr, play, rwd, ffw, green, yellow);
    }
    /**
     * Enable motion-adaptive LACE field merging. The browser defaults this
     * off for throughput, presenting interlaced fields by line doubling;
     * progressive displays are unchanged either way. Switching live drops
     * field history and re-presents the last completed frame.
     * @param {boolean} enabled
     */
    set_deinterlace(enabled) {
        wasm.webemu_set_deinterlace(this.__wbg_ptr, enabled);
    }
    /**
     * Enable or mute the synthesized floppy drive sounds (motor hum,
     * head-step clicks, read hiss). On by default, like the desktop's
     * `[audio] floppy_sounds` knob.
     * @param {boolean} enabled
     */
    set_floppy_sounds(enabled) {
        const ret = wasm.webemu_set_floppy_sounds(this.__wbg_ptr, enabled);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Drive-sound level, 0-100, relative to Paula's output (the desktop's
     * `[audio] floppy_sounds_volume`).
     * @param {number} percent
     */
    set_floppy_sounds_volume(percent) {
        const ret = wasm.webemu_set_floppy_sounds_volume(this.__wbg_ptr, percent);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Emulated floppy drive speed (the desktop's `[floppy] speed`): a
     * data-rate percentage of 100/200/400/800, or 0 for turbo, where disk
     * DMA transfers complete almost instantly. Other values fall back to
     * 100. Applies immediately; drive mechanics stay at real speed.
     * @param {number} percent
     */
    set_floppy_speed(percent) {
        const ret = wasm.webemu_set_floppy_speed(this.__wbg_ptr, percent);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Digital joystick state for either port (1 or 2): the page's
     * keyboard-joystick mapping, or a Gamepad API bridge. Marks the port as
     * a joystick, which is what makes two-player work -- a second pad takes
     * port 1, exactly like unplugging the mouse to plug a stick in. `fire`
     * is the red/primary button, `button2` the blue/second button. Any port
     * number other than 1 means port 2, matching the core's convention.
     * @param {number} port
     * @param {boolean} up
     * @param {boolean} down
     * @param {boolean} left
     * @param {boolean} right
     * @param {boolean} fire
     * @param {boolean} button2
     */
    set_joystick_port(port, up, down, left, right, fire, button2) {
        wasm.webemu_set_joystick_port(this.__wbg_ptr, port, up, down, left, right, fire, button2);
    }
    /**
     * Port-2 joystick state. Superseded by `set_joystick_port`, kept
     * because it is the published page-glue API.
     * @param {boolean} up
     * @param {boolean} down
     * @param {boolean} left
     * @param {boolean} right
     * @param {boolean} fire
     * @param {boolean} button2
     */
    set_joystick_port2(up, down, left, right, fire, button2) {
        wasm.webemu_set_joystick_port2(this.__wbg_ptr, up, down, left, right, fire, button2);
    }
    /**
     * Whether the page is drawing a monitor bezel around the picture. A
     * drawn bezel widens the standard-scan presentation from the TV
     * aperture to the tube aperture -- every rendered row of the field,
     * the desktop's tube view -- because a real 1084's visible raster
     * exceeds even the whole captured field; the bezel's rounded corners
     * then crop into the extra overscan border instead of into the
     * picture. Full overscan and programmable scans are unaffected. The
     * last completed frame is re-presented under the new aperture, like
     * `set_overscan`, so a paused page repaints without stepping the
     * machine.
     * @param {boolean} drawn
     */
    set_monitor_bezel(drawn) {
        wasm.webemu_set_monitor_bezel(this.__wbg_ptr, drawn);
    }
    /**
     * Average the left and right channels into both outputs (the desktop's
     * `[audio] channel_mode = "mono"`). Off by default: Paula's hardware
     * panning, with two channels on each side.
     * @param {boolean} enabled
     */
    set_mono_audio(enabled) {
        wasm.webemu_set_mono_audio(this.__wbg_ptr, enabled);
    }
    /**
     * Presentation overscan, the desktop's `[display] overscan` knob:
     * "tv" (the default) masks the deep horizontal overscan margins like a
     * CRT bezel and presents standard screens as the captured TV
     * aperture; "full" presents the whole overscan field the renderer
     * produces; "smart" uses bounded automatic centring and lets autocrop
     * select from the complete raster. Unknown names are ignored. The
     * last completed frame is re-presented under the new aperture, so a
     * paused page repaints without stepping the machine.
     * @param {string} mode
     */
    set_overscan(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.webemu_set_overscan(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set CRT phosphor persistence as the fraction of the previous
     * presented frame retained (0.0 = off, at most 0.95). The browser
     * defaults it off. Switching live seeds a fresh trail and re-presents
     * the last completed frame.
     * @param {number} persistence
     */
    set_phosphor(persistence) {
        wasm.webemu_set_phosphor(this.__wbg_ptr, persistence);
    }
    /**
     * Plug a device into a port: "mouse", "joystick", "cd32", "analogue",
     * or "none". Unplugging releases every line the old device drove, so a
     * page whose gamepad goes away restores the mouse on port 1 with
     * `set_port_device(1, "mouse")` rather than leaving a stuck stick.
     * Unknown names are ignored.
     * @param {number} port
     * @param {string} device
     */
    set_port_device(port, device) {
        const ptr0 = passStringToWasm0(device, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_set_port_device(this.__wbg_ptr, port, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Presentation scaling, the desktop's `[display] scaling` knob:
     * "smooth" (the default) or "integer" -- whole-number device pixels
     * per buffer column and per scan line, centred in black, the look
     * WinUAE and Amiberry call integer scaling. Unknown names are
     * ignored, like `set_overscan`. The page draws the picture, so the
     * setting mostly shapes `present_layout`'s answer; it also changes
     * the buffer itself for a standard 60 Hz scan, whose captured
     * aperture is presented at its own woven rows rather than resampled
     * onto the 50 Hz aperture's row count (the desktop draws its
     * unresampled canvas under integer scaling the same way), so the
     * factors carry every scan line to the screen as one exact block.
     * The last completed frame is re-presented under the new setting,
     * like `set_overscan`, so a paused page repaints without stepping
     * the machine.
     * @param {string} mode
     */
    set_scaling(mode) {
        const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.webemu_set_scaling(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Centre the TV presentation on the glass, the desktop's `[display]
     * tv_h_centre` / `tv_v_centre` knobs (a monitor's H-CENTER/V-CENTER
     * controls). `h` is in lo-res pixels, positive moving the picture
     * right; `v` in scan lines, positive moving it down; both clamp to
     * the knobs' travel. Glass the nudged aperture exposes past the
     * captured raster shows black. A TV-aperture nudge, so it moves
     * nothing under full overscan. The last completed frame is
     * re-presented under the new centring, like `set_overscan`, so a
     * paused page repaints without stepping the machine.
     * @param {number} h
     * @param {number} v
     */
    set_tv_centre(h, v) {
        wasm.webemu_set_tv_centre(this.__wbg_ptr, h, v);
    }
    /**
     * @param {number} percent
     */
    set_volume_percent(percent) {
        wasm.webemu_set_volume_percent(this.__wbg_ptr, percent);
    }
    /**
     * The spectator's initial fingerprint, sent to the host for comparison.
     * @returns {Uint8Array}
     */
    spectate_identity() {
        const ret = wasm.webemu_spectate_identity(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Feed bytes from the host, split anywhere.
     * @param {Uint8Array} bytes
     */
    spectate_receive(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_spectate_receive(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * [spectating, frame, behind, checked, disk changes applied].
     * @returns {Float64Array}
     */
    spectate_status() {
        const ret = wasm.webemu_spectate_status(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {number} id
     */
    spectator_feed_close(id) {
        wasm.webemu_spectator_feed_close(this.__wbg_ptr, id);
    }
    /**
     * Confirmed frames retained for spectators.
     * @returns {number}
     */
    spectator_feed_frames() {
        const ret = wasm.webemu_spectator_feed_frames(this.__wbg_ptr);
        return ret;
    }
    /**
     * Open a feed cursor for one spectator at frame zero; returns its id.
     * Fails once the retained history is too large for a late joiner.
     * @returns {number}
     */
    spectator_feed_open() {
        const ret = wasm.webemu_spectator_feed_open(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Encode what a spectator still needs, up to about `max_bytes` (a disk
     * change is returned whole). Empty means it has everything so far.
     * @param {number} id
     * @param {number} max_bytes
     * @returns {Uint8Array}
     */
    spectator_feed_take(id, max_bytes) {
        const ret = wasm.webemu_spectator_feed_take(this.__wbg_ptr, id, max_bytes);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Call after loading ROM/disks into a fresh WebEmu, before any run/state load.
     * Connection codes and data-channel setup are handled by the page.
     * @param {number} player
     * @param {string} code
     * @param {number} delay
     * @param {number} window
     * @param {string} controller
     */
    start_netplay(player, code, delay, window, controller) {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(controller, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_start_netplay(this.__wbg_ptr, player, ptr0, len0, delay, window, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Follow a host's game on a fresh machine built from its media, before
     * any run. The page feeds `spectate_receive` from the host's stream.
     * @param {string} controller
     */
    start_spectating(controller) {
        const ptr0 = passStringToWasm0(controller, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.webemu_start_spectating(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Drain the mixed audio: interleaved stereo f32 at 44.1 kHz, one PAL
     * frame is 882 stereo frames. The page transfers the returned buffer to
     * the AudioWorklet.
     * @returns {Float32Array}
     */
    take_audio() {
        const ret = wasm.webemu_take_audio(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The running machine's video standard ("PAL" or "NTSC"). Follows
     * `load_state` like `machine_model`, so a page can re-point its video
     * select at what a state brought back. This is the machine's fitted
     * standard (the Agnus crystal), not the live BEAMCON0 PAL bit ECS
     * software can flip at runtime.
     * @returns {string}
     */
    video_standard() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.webemu_video_standard(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The video standards the constructor's `video` argument accepts, in
     * menu order. Like `models`, the page builds its select from this list
     * and its presence doubles as the feature test: older bundles have no
     * `video_standards` and the control stays hidden.
     * @returns {string[]}
     */
    static video_standards() {
        const ret = wasm.webemu_video_standards();
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WebEmu.prototype[Symbol.dispose] = WebEmu.prototype.free;

export function start() {
    wasm.start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_undefined_6cff064c44e0d823: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_debug_3853dbaf0bca30f9: function(arg0) {
            console.debug(arg0);
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_error_dd408a7b3cb542dd: function(arg0) {
            console.error(arg0);
        },
        __wbg_info_726982aff9befe16: function(arg0) {
            console.info(arg0);
        },
        __wbg_log_e6372b4fbfc9f81e: function(arg0) {
            console.log(arg0);
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_now_8b265300afd5f2b9: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_THIS_466428f93b4eaa76: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_c7aea38d4de089bc: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_42d4fae05e59267a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_e0db14a0eba6a812: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_warn_917d7f727ab78481: function(arg0) {
            console.warn(arg0);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./copperline_web_bg.js": import0,
    };
}

const WebEmuFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_webemu_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('copperline_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
