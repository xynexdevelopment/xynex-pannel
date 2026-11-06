import type { Server as SocketIOServer } from "socket.io";

/* Registry for the Socket.IO server. Services used to `import { io } from "server.ts"`, i.e. import
   the process entry point: any module that (transitively) imported docker.ts booted the whole panel
   (listening port, schedulers, SFTP) as a side effect and created a circular import. server.ts now
   registers the instance here at startup and services only depend on this tiny module. */
let current: SocketIOServer | null = null;

export function setIO(io: SocketIOServer): void { current = io; }
export function getIO(): SocketIOServer | null { return current; }

/** Emit to a room; a no-op when no socket server is registered (tests, CLI scripts). */
export function emitToRoom(room: string, event: string, ...args: unknown[]): void {
  current?.to(room).emit(event, ...args);
}
