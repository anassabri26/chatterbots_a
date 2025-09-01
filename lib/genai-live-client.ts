/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import {
  GoogleGenAI,
  LiveCallbacks,
  LiveClientToolResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
  Session,
} from '@google/genai';
import EventEmitter from 'eventemitter3';
import { DEFAULT_LIVE_API_MODEL } from './constants';
import { base64ToArrayBuffer } from './utils';

/**
 * Represents a single log entry in the system.
 * Used for tracking and displaying system events, messages, and errors.
 */
export interface StreamingLog {
  // Optional count for repeated log entries
  count?: number;
  // Optional additional data associated with the log
  data?: unknown;
  // Timestamp of when the log was created
  date: Date;
  // The log message content
  message: string | object;
  // The type/category of the log entry
  type: string;
}

export interface GroundingChunk {
  web: {
    uri: string;
    title: string;
  };
}

/**
 * Event types that can be emitted by the MultimodalLiveClient.
 * Each event corresponds to a specific message from GenAI or client state change.
 */
export interface LiveClientEventTypes {
  // Emitted when audio data is received
  audio: (data: ArrayBuffer) => void;
  // Emitted when the connection closes
  close: (event: CloseEvent) => void;
  // Emitted when content is received from the server
  content: (data: LiveServerContent) => void;
  // Emitted when an error occurs
  error: (e: ErrorEvent) => void;
  // Emitted when the server interrupts the current generation
  interrupted: () => void;
  // Emitted for logging events
  log: (log: StreamingLog) => void;
  // Emitted when the connection opens
  open: () => void;
  // Emitted when the initial setup is complete
  setupcomplete: () => void;
  // Emitted when a tool call is received
  toolcall: (toolCall: LiveServerToolCall) => void;
  // Emitted when a tool call is cancelled
  toolcallcancellation: (
    toolcallCancellation: LiveServerToolCallCancellation
  ) => void;
  // Emitted when the current turn is complete
  turncomplete: () => void;
  // Emitted when grounding chunks are received
  grounding: (chunks: GroundingChunk[]) => void;
}

// FIX: Switched from inheritance to composition for EventEmitter to fix type resolution issues.
export class GenAILiveClient {
  public readonly model: string = DEFAULT_LIVE_API_MODEL;

  protected readonly client: GoogleGenAI;
  protected session?: Session;

  private emitter = new EventEmitter<LiveClientEventTypes>();

  private _status: 'connected' | 'disconnected' | 'connecting' = 'disconnected';
  public get status() {
    return this._status;
  }

  /**
   * Creates a new GenAILiveClient instance.
   * @param apiKey - API key for authentication with Google GenAI
   * @param model - Optional model name to override the default model
   */
  constructor(apiKey: string, model?: string) {
    if (model) this.model = model;

    this.client = new GoogleGenAI({
      apiKey: apiKey,
    });
  }

  // FIX: Delegating event emitter methods to the internal emitter instance.
  on<K extends keyof LiveClientEventTypes>(
    event: K,
    listener: LiveClientEventTypes[K],
    context?: any,
  ): this {
    // FIX: Cast listener to `any` to bypass TypeScript's inability to correlate
    // the listener type with the event name in this generic implementation.
    // The public API remains type-safe.
    this.emitter.on(event, listener as any, context);
    return this;
  }

  off<K extends keyof LiveClientEventTypes>(
    event: K,
    listener?: LiveClientEventTypes[K],
    context?: any,
    once?: boolean,
  ): this {
    // FIX: Cast listener to `any` to bypass TypeScript's inability to correlate
    // the listener type with the event name in this generic implementation.
    // The public API remains type-safe.
    this.emitter.off(event, listener as any, context, once);
    return this;
  }

  emit<K extends keyof LiveClientEventTypes>(
    event: K,
    ...args: Parameters<LiveClientEventTypes[K]>
  ): boolean {
    // FIX: Cast args to `any` to bypass TypeScript's inability to correlate
    // the arguments with the event name in this generic implementation.
    // The public API remains type-safe.
    return this.emitter.emit(event, ...(args as any));
  }

  public async connect(config: LiveConnectConfig): Promise<boolean> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return false;
    }

    this._status = 'connecting';
    const callbacks: LiveCallbacks = {
      onopen: this.onOpen.bind(this),
      onmessage: this.onMessage.bind(this),
      onerror: this.onError.bind(this),
      onclose: this.onClose.bind(this),
    };

    try {
      this.session = await this.client.live.connect({
        model: this.model,
        config: {
          ...config,
        },
        callbacks,
      });
    } catch (e) {
      console.error('Error connecting to GenAI Live:', e);
      this._status = 'disconnected';
      this.session = undefined;
      return false;
    }

    this._status = 'connected';
    return true;
  }

  public disconnect() {
    this.session?.close();
    this.session = undefined;
    this._status = 'disconnected';

    this.log('client.close', `Disconnected`);
    return true;
  }

  public send(parts: Part | Part[], turnComplete: boolean = true) {
    if (this._status !== 'connected' || !this.session) {
      this.emit('error', new ErrorEvent('error', { message: 'Client is not connected' }));
      return;
    }
    try {
      this.session.sendClientContent({ turns: parts, turnComplete });
      this.log(`client.send`, parts);
    } catch (error) {
      console.error('Error sending content:', error);
      this.emit('error', new ErrorEvent('error', { error: error as Error, message: 'Failed to send content.' }));
    }
  }

  public sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    if (this._status !== 'connected' || !this.session) {
      // Silently ignore if not connected, as this can be called by the audio
      // recorder after a disconnect has been initiated.
      return;
    }
    try {
      chunks.forEach(chunk => {
        this.session!.sendRealtimeInput({ media: chunk });
      });

      let hasAudio = false;
      let hasVideo = false;
      for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        if (ch.mimeType.includes('audio')) hasAudio = true;
        if (ch.mimeType.includes('image')) hasVideo = true;
        if (hasAudio && hasVideo) break;
      }

      let message = 'unknown';
      if (hasAudio && hasVideo) message = 'audio + video';
      else if (hasAudio) message = 'audio';
      else if (hasVideo) message = 'video';
      this.log(`client.realtimeInput`, message);
    } catch (error) {
      console.error('Error sending realtime input:', error);
      this.emit('error', new ErrorEvent('error', { error: error as Error, message: 'Failed to send media data.' }));
    }
  }

  public sendToolResponse(toolResponse: LiveClientToolResponse) {
    if (this._status !== 'connected' || !this.session) {
      this.emit('error', new ErrorEvent('error', { message: 'Client is not connected' }));
      return;
    }
    try {
      if (
        toolResponse.functionResponses &&
        toolResponse.functionResponses.length
      ) {
        this.session.sendToolResponse({
          functionResponses: toolResponse.functionResponses!,
        });
      }
      this.log(`client.toolResponse`, { toolResponse });
    } catch (error) {
      console.error('Error sending tool response:', error);
      this.emit('error', new ErrorEvent('error', { error: error as Error, message: 'Failed to send tool response.' }));
    }
  }

  protected onMessage(message: any /* LiveServerMessage */) {
    if (message.setupComplete) {
      this.emit('setupcomplete');
      return;
    }
    if (message.toolCall) {
      this.log('server.toolCall', message);
      this.emit('toolcall', message.toolCall);
      return;
    }
    if (message.toolCallCancellation) {
      this.log('receive.toolCallCancellation', message);
      this.emit('toolcallcancellation', message.toolCallCancellation);
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;

      if (serverContent.groundingMetadata?.groundingChunks?.length) {
        this.emit(
          'grounding',
          serverContent.groundingMetadata.groundingChunks,
        );
        this.log(
          'server.grounding',
          serverContent.groundingMetadata.groundingChunks,
        );
      }

      if ('interrupted' in serverContent) {
        this.log('receive.serverContent', 'interrupted');
        this.emit('interrupted');
        return;
      }
      if ('turnComplete' in serverContent) {
        this.log('server.send', 'turnComplete');
        this.emit('turncomplete');
      }

      if (serverContent.modelTurn?.parts) {
        const otherParts: Part[] = [];
        for (const part of serverContent.modelTurn.parts) {
          if (
            part.inlineData?.mimeType?.startsWith('audio/pcm') &&
            part.inlineData.data
          ) {
            try {
              const data = base64ToArrayBuffer(part.inlineData.data);
              this.emit('audio', data);
              this.log(`server.audio`, `buffer (${data.byteLength})`);
            } catch (e) {
              console.error('Failed to decode base64 audio data:', e);
            }
          } else {
            otherParts.push(part);
          }
        }

        if (otherParts.length) {
          const content: LiveServerContent = {
            modelTurn: { parts: otherParts },
          };
          this.emit('content', content);
          this.log(`server.content`, message);
        }
      } else if (serverContent.modelTurn) {
        const content: LiveServerContent = { modelTurn: serverContent.modelTurn };
        this.emit('content', content);
        this.log(`server.content`, message);
      } else {
        console.log('received unmatched message', message);
      }
    }
  }

  protected onError(e: ErrorEvent) {
    this._status = 'disconnected';
    console.error('error:', e);

    const message = `Could not connect to GenAI Live: ${e.message}`;
    this.log(`server.${e.type}`, message);
    this.emit('error', e);
  }

  protected onOpen() {
    this._status = 'connected';
    this.emit('open');
  }

  protected onClose(e: CloseEvent) {
    this._status = 'disconnected';
    let reason = e.reason || '';
    if (reason.toLowerCase().includes('error')) {
      const prelude = 'ERROR]';
      const preludeIndex = reason.indexOf(prelude);
      if (preludeIndex > 0) {
        reason = reason.slice(preludeIndex + prelude.length + 1, Infinity);
      }
    }

    this.log(
      `server.${e.type}`,
      `disconnected ${reason ? `with reason: ${reason}` : ``}`
    );
    this.emit('close', e);
  }

  /**
   * Internal method to emit a log event.
   * @param type - Log type
   * @param message - Log message
   */
  protected log(type: string, message: string | object) {
    this.emit('log', {
      type,
      message,
      date: new Date(),
    });
  }
}
