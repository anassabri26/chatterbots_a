/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { Agent, createNewAgent } from '@/lib/presets/agents';
import { useAgent, useUI, useUser } from '@/lib/state';
import c from 'classnames';
import { useEffect, useState } from 'react';

export default function Header() {
  const { showUserConfig, setShowUserConfig, setShowAgentEdit } = useUI();
  const { name } = useUser();
  const { current, setCurrent, availablePresets, availablePersonal, addAgent } =
    useAgent();

  let [showRoomList, setShowRoomList] = useState(false);

  useEffect(() => {
    const closeRoomList = () => setShowRoomList(false);
    window.addEventListener('click', closeRoomList);
    return () => window.removeEventListener('click', closeRoomList);
  }, []);

  function changeAgent(agent: Agent | string) {
    // Only update the state. The KeynoteCompanion component will handle the reconnect.
    setCurrent(agent);
  }

  function addNewChatterBot() {
    // Add the new agent and open the edit modal.
    // The KeynoteCompanion component will handle disconnecting the old session.
    const newAgent = createNewAgent();
    addAgent(newAgent);
    setShowAgentEdit(true);
  }

  return (
    <header>
      <div className="roomInfo">
        <div className="roomName">
          <button
            onClick={e => {
              e.stopPropagation();
              setShowRoomList(!showRoomList);
            }}
          >
            <h1 className={c({ active: showRoomList })}>
              {current.name}
              <span className="icon">arrow_drop_down</span>
            </h1>
          </button>

          <button
            onClick={() => setShowAgentEdit(true)}
            className="button createButton"
          >
            <span className="icon">edit</span> Edit
          </button>
        </div>

        <div className={c('roomList', { active: showRoomList })}>
          <div>
            <h3>Presets</h3>
            <ul>
              {availablePresets
                .filter(agent => agent.id !== current.id)
                .map(agent => (
                  <li
                    key={agent.name}
                    className={c({ active: agent.id === current.id })}
                  >
                    <button
                      onClick={() => {
                        changeAgent(agent);
                      }}
                    >
                      {agent.name}
                    </button>
                  </li>
                ))}
            </ul>
          </div>

          <div>
            <h3>Your ChatterBots</h3>
            {
              <ul>
                {availablePersonal.length ? (
                  availablePersonal.map(({ id, name }) => (
                    <li key={name} className={c({ active: id === current.id })}>
                      <button
                        onClick={() => {
                          changeAgent(id);
                        }}
                      >
                        {name}
                      </button>
                    </li>
                  ))
                ) : (
                  <p>None yet.</p>
                )}
              </ul>
            }
            <button
              className="newRoomButton"
              onClick={() => {
                addNewChatterBot();
              }}
            >
              <span className="icon">add</span>New ChatterBot
            </button>
          </div>
        </div>
      </div>
      <button
        className="userSettingsButton"
        onClick={() => setShowUserConfig(!showUserConfig)}
      >
        <p className="user-name">{name || 'Your name'}</p>
        <span className="icon">tune</span>
      </button>
    </header>
  );
}
