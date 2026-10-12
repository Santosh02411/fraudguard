import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

// Socket.io connects to the backend's origin, not the REST /api/v1 path —
// derive it from REACT_APP_SOCKET_URL if set, otherwise strip a trailing
// /api or /api/v1 off REACT_APP_API_URL, otherwise fall back to the same
// localhost:5000 dev default AuthContext.js uses.
function resolveSocketUrl() {
  if (process.env.REACT_APP_SOCKET_URL) return process.env.REACT_APP_SOCKET_URL;
  const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:5000/api/v1';
  return apiUrl.replace(/\/api(\/v1)?\/?$/, '');
}

const SOCKET_URL = resolveSocketUrl();

/**
 * One socket connection per logged-in session, shared via context.
 * Connects/reconnects when `user` changes, disconnects on logout —
 * this is the "push" side of real-time alerts: components subscribe to
 * events (transaction:new, alert:new, simulation:*) instead of polling
 * a REST endpoint on a timer.
 */
export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      return;
    }

    const token = localStorage.getItem('fg_access_token');
    if (!token) return;

    const socket = io(SOCKET_URL, { auth: { token }, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
