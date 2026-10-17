const signalRConnection = new signalR.HubConnectionBuilder()
    .withUrl("/callhub")
    .withAutomaticReconnect()
    .build();

//SignalR LifeCycle Events
signalRConnection.onclose((error) => {
    console.error("SignalR connection closed", error);
});


signalRConnection.onreconnecting((error) => {
    console.error("SignalR connection reconnecting", error);
});

signalRConnection.onreconnected((connectionId) => {
    console.log("SignalR connection reconnected", connectionId);
});

//Start the SignalR Connection
async function startSignalRConnection() {
    try {
        await signalRConnection.start();
        console.log("SignalR connected");
    } catch (error) {
        console.log("SignalR connection failed")
    }
}

startSignalRConnection();