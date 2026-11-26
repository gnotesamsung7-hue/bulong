package io.github.gnotesamsung7hue.bulong;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Thin bridge to Google Nearby Connections (Bluetooth / BLE, no internet).
 * It only finds phones, links them and moves text. The mesh relay,
 * encryption and chats live in www/mesh.js.
 */
@CapacitorPlugin(name = "BulongMesh")
public class BulongMeshPlugin extends Plugin {
    private static final String SERVICE_ID = "io.github.gnotesamsung7hue.bulong.mesh";
    private ConnectionsClient client;
    private String myName = "bulong";
    private final Map<String, String> names = new HashMap<>();
    private ActivityResultLauncher<String[]> permLauncher;
    private PluginCall pendingPermCall;

    @Override
    public void load() {
        client = Nearby.getConnectionsClient(getContext());
        permLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(),
            result -> {
                PluginCall c = pendingPermCall;
                pendingPermCall = null;
                if (c != null) {
                    JSObject r = new JSObject();
                    r.put("granted", allGranted());
                    c.resolve(r);
                }
            });
    }

    private String[] needed() {
        List<String> p = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            p.add(Manifest.permission.BLUETOOTH_SCAN);
            p.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            p.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            p.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        // Nearby Connections checks location on every Android version
        p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        p.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        return p.toArray(new String[0]);
    }

    private boolean allGranted() {
        for (String s : needed()) {
            if (ContextCompat.checkSelfPermission(getContext(), s) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @PluginMethod
    public void checkPerms(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", allGranted());
        call.resolve(r);
    }

    @PluginMethod
    public void askPerms(PluginCall call) {
        if (allGranted()) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        pendingPermCall = call;
        permLauncher.launch(needed());
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            JSObject o = new JSObject();
            o.put("endpointId", id);
            o.put("name", info.getEndpointName());
            notifyListeners("found", o);
        }

        @Override
        public void onEndpointLost(@NonNull String id) {
            JSObject o = new JSObject();
            o.put("endpointId", id);
            notifyListeners("lost", o);
        }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String id, @NonNull Payload p) {
            if (p.getType() != Payload.Type.BYTES || p.asBytes() == null) return;
            JSObject o = new JSObject();
            o.put("endpointId", id);
            o.put("data", new String(p.asBytes(), StandardCharsets.UTF_8));
            notifyListeners("data", o);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate u) {}
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            names.put(id, info.getEndpointName());
            client.acceptConnection(id, payloads).addOnFailureListener(e -> error("accept", e));
        }

        @Override
        public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution r) {
            JSObject o = new JSObject();
            o.put("endpointId", id);
            o.put("name", names.get(id));
            if (r.getStatus().isSuccess()) {
                notifyListeners("connected", o);
            } else {
                o.put("code", r.getStatus().getStatusCode());
                notifyListeners("connectFailed", o);
            }
        }

        @Override
        public void onDisconnected(@NonNull String id) {
            JSObject o = new JSObject();
            o.put("endpointId", id);
            notifyListeners("disconnected", o);
        }
    };

    private void error(String where, Exception e) {
        JSObject o = new JSObject();
        o.put("where", where);
        o.put("message", String.valueOf(e.getMessage()));
        notifyListeners("error", o);
    }

    @PluginMethod
    public void start(PluginCall call) {
        myName = call.getString("name", "bulong");
        client.stopAdvertising();
        client.stopDiscovery();
        AdvertisingOptions ao = new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build();
        DiscoveryOptions dopts = new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build();
        client.startAdvertising(myName, SERVICE_ID, lifecycle, ao)
            .addOnFailureListener(e -> error("advertise", e));
        client.startDiscovery(SERVICE_ID, discovery, dopts)
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage())));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
        call.resolve();
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("endpointId");
        if (id == null) {
            call.reject("endpointId missing");
            return;
        }
        client.requestConnection(myName, id, lifecycle)
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage())));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String id = call.getString("endpointId");
        if (id != null) client.disconnectFromEndpoint(id);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        JSArray ids = call.getArray("endpointIds");
        String data = call.getString("data");
        List<String> list = new ArrayList<>();
        try {
            for (int i = 0; ids != null && i < ids.length(); i++) list.add(ids.getString(i));
        } catch (Exception e) {
            call.reject("bad endpointIds");
            return;
        }
        if (list.isEmpty() || data == null) {
            call.resolve();
            return;
        }
        client.sendPayload(list, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8)))
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage())));
    }

    @Override
    protected void handleOnDestroy() {
        if (client != null) client.stopAllEndpoints();
    }
}
