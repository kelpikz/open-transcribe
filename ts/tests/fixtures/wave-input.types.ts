/** Compile-only checks: native calls must retain their required arguments. */
import type { Pointer } from "bun:ffi";
import type { WaveInput } from "../../src/desktop/microphone.js";

export function checkWaveInputArguments(wave: WaveInput, handle: Pointer, header: Buffer): void {
	wave.waveInStart(handle);
	wave.waveInAddBuffer(handle, header, 48);
	// @ts-expect-error A native input handle is required.
	wave.waveInStart();
	// @ts-expect-error A null handle cannot be passed to a native input operation.
	wave.waveInStart(null);
	// @ts-expect-error The native header size is required.
	wave.waveInAddBuffer(handle, header);
	// @ts-expect-error DLL ownership belongs to the loading implementation.
	wave.libraries;
}
