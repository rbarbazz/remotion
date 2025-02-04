import type {
	LogLevel,
	MediaFn,
	OnVideoTrack,
	VideoTrack,
} from '@remotion/media-parser';
import type {ConvertMediaVideoCodec} from './codec-id';
import type {ConvertMediaState} from './convert-media';
import Error from './error-cause';
import type {ResolveVideoActionFn} from './resolve-video-action';
import {resolveVideoAction} from './resolve-video-action';
import {createVideoDecoder} from './video-decoder';
import {getVideoDecoderConfigWithHardwareAcceleration} from './video-decoder-config';
import {createVideoEncoder} from './video-encoder';
import {getVideoEncoderConfig} from './video-encoder-config';

export const makeVideoTrackHandler =
	({
		state,
		onVideoFrame,
		onMediaStateUpdate,
		abortConversion,
		convertMediaState,
		controller,
		videoCodec,
		onVideoTrack,
		logLevel,
	}: {
		state: MediaFn;
		onVideoFrame:
			| null
			| ((frame: VideoFrame, track: VideoTrack) => Promise<void>);
		onMediaStateUpdate: null | ((state: ConvertMediaState) => void);
		abortConversion: (errCause: Error) => void;
		convertMediaState: ConvertMediaState;
		controller: AbortController;
		videoCodec: ConvertMediaVideoCodec;
		onVideoTrack: ResolveVideoActionFn;
		logLevel: LogLevel;
	}): OnVideoTrack =>
	async (track) => {
		if (controller.signal.aborted) {
			throw new Error('Aborted');
		}

		const videoEncoderConfig = await getVideoEncoderConfig({
			codec: videoCodec === 'vp9' ? 'vp09.00.10.08' : videoCodec,
			height: track.displayAspectHeight,
			width: track.displayAspectWidth,
		});
		const videoDecoderConfig =
			await getVideoDecoderConfigWithHardwareAcceleration(track);
		const videoOperation = await resolveVideoAction({
			videoDecoderConfig,
			videoEncoderConfig,
			track,
			videoCodec,
			resolverFunction: onVideoTrack,
		});

		if (videoOperation === 'drop') {
			return null;
		}

		if (videoOperation === 'copy') {
			const videoTrack = await state.addTrack({
				type: 'video',
				color: track.color,
				width: track.codedWidth,
				height: track.codedHeight,
				codec: track.codecWithoutConfig,
				codecPrivate: track.codecPrivate,
			});
			return async (sample) => {
				await state.addSample(
					new EncodedVideoChunk(sample),
					videoTrack.trackNumber,
					true,
				);
				convertMediaState.decodedVideoFrames++;
				onMediaStateUpdate?.({...convertMediaState});
			};
		}

		if (videoEncoderConfig === null) {
			abortConversion(
				new Error(
					`Could not configure video encoder of track ${track.trackId}`,
				),
			);
			return null;
		}

		if (videoDecoderConfig === null) {
			abortConversion(
				new Error(
					`Could not configure video decoder of track ${track.trackId}`,
				),
			);
			return null;
		}

		const {trackNumber} = await state.addTrack({
			type: 'video',
			color: track.color,
			width: track.codedWidth,
			height: track.codedHeight,
			codec: videoCodec,
			codecPrivate: null,
		});

		const videoEncoder = createVideoEncoder({
			onChunk: async (chunk) => {
				await state.addSample(chunk, trackNumber, true);
				convertMediaState.encodedVideoFrames++;
				onMediaStateUpdate?.({...convertMediaState});
			},
			onError: (err) => {
				abortConversion(
					new Error(
						`Video encoder of track ${track.trackId} failed (see .cause of this error)`,
						{
							cause: err,
						},
					),
				);
			},
			signal: controller.signal,
			config: videoEncoderConfig,
			logLevel,
		});

		const videoDecoder = createVideoDecoder({
			config: videoDecoderConfig,
			onFrame: async (frame) => {
				await onVideoFrame?.(frame, track);
				await videoEncoder.encodeFrame(frame);
				convertMediaState.decodedVideoFrames++;
				onMediaStateUpdate?.({...convertMediaState});

				frame.close();
			},
			onError: (err) => {
				abortConversion(
					new Error(
						`Video decoder of track ${track.trackId} failed (see .cause of this error)`,
						{
							cause: err,
						},
					),
				);
			},
			signal: controller.signal,
			logLevel,
		});

		state.addWaitForFinishPromise(async () => {
			await videoDecoder.waitForFinish();
			await videoEncoder.waitForFinish();
			videoDecoder.close();
			videoEncoder.close();
		});

		return async (chunk) => {
			await videoDecoder.processSample(chunk);
		};
	};
