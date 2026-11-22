package test.clipboard.source;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.DragEvent;
import android.view.View;
import android.widget.TextView;

public class Source extends Activity {
    public void onCreate(Bundle state) {
        super.onCreate(state);
        Uri uri = Uri.parse("content://test.clipboard.source.files/fixture");
        boolean shortRead = getIntent().getBooleanExtra("shortRead", false);
        if (shortRead) uri = Uri.parse("content://test.clipboard.source.files/short-read");
        ClipData clip = ClipData.newRawUri("PR fixture", uri);
        if (getIntent().hasExtra("link")) {
            // Chrome-style ACTION_SEND: EXTRA_TEXT is the URL, ClipData grants access to a thumbnail.
            Intent share = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .setClassName("com.jericx.syncclipboardmobile", "com.jericx.syncclipboardmobile.share.ShareActivity")
                .putExtra(Intent.EXTRA_TEXT, getIntent().getStringExtra("link"))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Uri preview = Uri.parse("content://test.clipboard.source.files/favicon");
            ClipData previewClip = ClipData.newUri(getContentResolver(), "preview", preview);
            if (getIntent().getBooleanExtra("withStream", false)) previewClip.addItem(new ClipData.Item(uri));
            share.setClipData(previewClip);
            if (getIntent().getBooleanExtra("withStream", false)) share.putExtra(Intent.EXTRA_STREAM, uri);
            startActivity(share);
            finish();
            return;
        }
        if (getIntent().getBooleanExtra("share", false)) {
            Intent share = new Intent(Intent.ACTION_SEND).setType("application/octet-stream")
                .setClassName("com.jericx.syncclipboardmobile", "com.jericx.syncclipboardmobile.share.ShareActivity")
                .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            share.setClipData(clip);
            startActivity(share);
            finish();
            return;
        }
        TextView view = new TextView(this);
        view.setText("Hold to drag the PR fixture");
        view.setGravity(android.view.Gravity.CENTER);
        view.setOnLongClickListener(v -> {
            boolean started = v.startDragAndDrop(clip, new View.DragShadowBuilder(v), this, View.DRAG_FLAG_GLOBAL | View.DRAG_FLAG_GLOBAL_URI_READ);
            Log.i("PRDropFixture", "started=" + started);
            return true;
        });
        view.setOnDragListener((v, e) -> {
            if (e.getAction() == DragEvent.ACTION_DRAG_ENDED) Log.i("PRDropFixture", "accepted=" + e.getResult());
            return e.getAction() == DragEvent.ACTION_DRAG_STARTED;
        });
        setContentView(view);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
    }
}
