/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef } from 'react';
import { LiveConnectConfig, Modality } from '@google/genai';

import BasicFace from '../basic-face/BasicFace';
import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import { createSystemInstructions } from '@/lib/prompts';
import { useAgent, useUI, useUser } from '@/lib/state';
import GroundingReferences from './GroundingReferences';

export default function KeynoteCompanion() {
  const {
    client,
    connected,
    setConfig,
    config,
    connect,
    disconnect,
    groundingChunks,
  } = useLiveAPIContext();
  const faceCanvasRef = useRef<HTMLCanvasElement>(null);
  const user = useUser();
  const { current } = useAgent();
  const { useGrounding, showAgentEdit, showUserConfig } = useUI();

  // Use refs to manage connection logic state across renders without causing re-renders.
  const isReconnectingRef = useRef(false);
  const wasConnectedBeforeModal = useRef(false);

  // This effect is the single source of truth for managing the connection
  // state based on user actions and settings changes.
  useEffect(() => {
    // 1. Define the desired configuration based on the current app state.
    const newConfig: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: current.voice },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: createSystemInstructions(current, user),
          },
        ],
      },
    };
    if (useGrounding) {
      newConfig.tools = [{ googleSearch: {} }];
    }

    // Always keep the config in the context up-to-date.
    setConfig(newConfig);

    const configChanged = JSON.stringify(newConfig) !== JSON.stringify(config);
    const isModalOpen = showAgentEdit || showUserConfig;

    // --- Connection Logic ---

    // Reusable reconnect function to handle all session restarts.
    const handleReconnect = async () => {
      // Use a lock to prevent concurrent reconnection attempts.
      if (isReconnectingRef.current) return;
      isReconnectingRef.current = true;
      try {
        // Disconnect first if a session is already active.
        if (connected) {
          await disconnect();
        }

        // It's possible a modal was opened while we were disconnecting.
        // Check the latest state directly from the store to prevent a race condition.
        const isModalOpenNow =
          useUI.getState().showAgentEdit || useUI.getState().showUserConfig;

        if (isModalOpenNow) {
          // A modal is open, so we must not reconnect.
          // The effect will run again when the modal closes and handle the reconnect.
          return;
        }

        // Connect with the latest configuration.
        await connect(newConfig);
      } catch (error) {
        console.error('Failed to reconnect session:', error);
        client.emit(
          'error',
          new ErrorEvent('error', {
            error: error as Error,
            message: 'Failed to apply new settings. Please try again.',
          })
        );
      } finally {
        isReconnectingRef.current = false;
      }
    };

    // If a modal is open, we must be disconnected.
    if (isModalOpen) {
      if (connected) {
        // Remember that we were connected so we can auto-reconnect later.
        wasConnectedBeforeModal.current = true;
        disconnect().catch(error => {
          console.error('Failed to disconnect on modal open:', error);
        });
      }
      return; // Stop further processing until modal is closed.
    }

    // If a modal was just closed, or if the config changed while connected,
    // we need to restart the session.
    if (wasConnectedBeforeModal.current || (connected && configChanged)) {
      wasConnectedBeforeModal.current = false; // Reset the flag
      handleReconnect().catch(e => {
        // The internal handler should catch this, but this is an extra safeguard.
        console.error('Unhandled error during reconnect:', e);
      });
    }
  }, [
    user,
    current,
    useGrounding,
    config,
    connected,
    showAgentEdit,
    showUserConfig,
    setConfig,
    disconnect,
    connect,
    client,
  ]);

  // Initiate the session when the Live API connection is established
  // Instruct the model to send an initial greeting message
  useEffect(() => {
    const beginSession = async () => {
      if (!connected) return;
      client.send(
        {
          text: 'Greet the user and introduce yourself and your role.',
        },
        true
      );
    };
    beginSession();
  }, [client, connected]);

  return (
    <div className="keynote-companion">
      <BasicFace canvasRef={faceCanvasRef!} color={current.bodyColor} />
      <GroundingReferences chunks={groundingChunks} />
    </div>
  );
}
