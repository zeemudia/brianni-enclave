{
  "targets": [
    {
      "target_name": "vsock_native",
      "sources": ["src/vsock_addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='linux'", {
          "cflags": ["-fPIC"],
          "cflags_cc": ["-fPIC", "-std=c++17"]
        }]
      ]
    }
  ]
}
