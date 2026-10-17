using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;


namespace Video_Call.Hubs
{
    public class CallHub : Hub
    {
        private static readonly ConcurrentDictionary<
            string, ConcurrentDictionary<string, byte>> Rooms = new();

        //Create a New Room
        public async Task<string> CreateRoom()
        {
            string roomid = Guid.NewGuid().ToString("N");
            string connectionId = Context.ConnectionId;

            var participants = new ConcurrentDictionary<string, byte>();
            participants.TryAdd(connectionId, 0);


            if(!Rooms.TryAdd(roomid, participants))
            {
                throw new HubException("Could not create room,Please try again");
            }

            try 
            {
                await Groups.AddToGroupAsync(connectionId, roomid);


                await Clients.Caller.SendAsync(
                    "ExistingParticipants",
                    Array.Empty<string>());

                return roomid;

            }
            catch
            {
                Rooms.TryRemove(roomid, out _);
                throw;
            }
        }
       
        //Join a room and notify existing participants
        public async Task JoinRoom(string roomId)
        {
            if (string.IsNullOrWhiteSpace(roomId))
            {
                throw new HubException("Room ID is required.");
            }

            //Find Existing Room
            if(!Rooms.TryGetValue(roomId, out var participants))
            {
                throw new HubException("Room not found");
            }

            string connectionId = Context.ConnectionId;

            var existingParticipants = participants.Keys.ToArray();

            // Add the connection to the room before notifying others.
            await Groups.AddToGroupAsync(connectionId, roomId);

            // Register the new participant
            if (!participants.TryAdd(connectionId, 0))
            {
                await Groups.RemoveFromGroupAsync(connectionId, roomId);
                throw new HubException("Could not join the room.");
            }

            //Tell the caller about existing participants
            await Clients.Caller.SendAsync(
                "ExistingParticipants",
                existingParticipants);

            //Notify existing participants about the new participant
            await Clients.OthersInGroup(roomId).SendAsync(
                "ParticipantJoined",
                connectionId);
        }


        // Send a WebRTC offer to another participant
        public async Task SendOffer(string targetId, object offer)
        {
            if (!AreInSameRoom(targetId))
            {
                throw new HubException("Participant is not in your room");
            }

            await Clients.Client(targetId).SendAsync(
                "ReceiveOffer",
                Context.ConnectionId,
                offer);
        }

        // Send a WebRTC answer to another participant
        public async Task SendAnswer(string targetId, object answer)
        {
            if (!AreInSameRoom(targetId))
            {
                throw new HubException("Participant is not in your room");
            }

            await Clients.Client(targetId).SendAsync(
                "ReceiveAnswer",
                Context.ConnectionId,
                answer);
        }

        // Send an ICE candidate to another participant
        public async Task SendIceCandidate(
            string targetId,
            object candidate)
        {
            if (!AreInSameRoom(targetId))
            {
                throw new HubException("Participant is not in your room");
            }

            await Clients.Client(targetId).SendAsync(
                "ReceiveIceCandidate",
                Context.ConnectionId,
                candidate);
        }

        // Check whether both connections belong to the same room
        private bool AreInSameRoom(string targetId)
        {
            if (string.IsNullOrWhiteSpace(targetId))
            {
                return false;
            }

            return Rooms.Any(room =>
                room.Value.ContainsKey(Context.ConnectionId) &&
                room.Value.ContainsKey(targetId));
        }


        //Leave a room and notify remaining participants
        public async Task LeaveRoom(string roomId)
        {
            if (string.IsNullOrWhiteSpace(roomId))
            {
                return;
            }

            await RemoveFromRoom(roomId, Context.ConnectionId);
        }

        public override async Task OnDisconnectedAsync(
            Exception? exception)
        {
            foreach (var room in Rooms)
            {
                if (room.Value.ContainsKey(Context.ConnectionId))
                {
                    await RemoveFromRoom(
                        room.Key,
                        Context.ConnectionId);
                }
            }

            await base.OnDisconnectedAsync(exception);
        }

        private async Task RemoveFromRoom(
            string roomId,
            string connectionId)
        {
            if (!Rooms.TryGetValue(roomId, out var participants))
            {
                return;
            }

            if (!participants.TryRemove(connectionId, out _))
            {
                return;
            }

            await Groups.RemoveFromGroupAsync(connectionId, roomId);

            await Clients.Group(roomId).SendAsync(
                "ParticipantLeft",
                connectionId);

            if (participants.IsEmpty)
            {
                Rooms.TryRemove(roomId, out _);
            }
        }
    }
}
