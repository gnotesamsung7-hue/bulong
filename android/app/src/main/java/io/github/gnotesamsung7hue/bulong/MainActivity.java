package io.github.gnotesamsung7hue.bulong;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BulongMeshPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
