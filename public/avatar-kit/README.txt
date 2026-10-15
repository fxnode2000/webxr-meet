WebXR Meet avatar template
==========================
1. Press N in the 3D viewport, open the 'Avatar' tab. If it is missing, open the Text Editor, choose avatar_kit.py, Run Script.
2. Edit the four meshes: Head, Torso, HandL, HandR. Keep the names. Keep each origin in the middle of its part
   (hands: where the controller is held). Face the front view (-Y). Stay near the GUIDE height of 1.75 m.
3. Share one material and one colour texture (max 512x512). The palette texture trick keeps it tiny.
4. Click 'Check avatar' until it passes, then 'Check and export .glb'. Upload the .glb on the join screen.
Limits: Head 1000 tris, Torso 800, each hand 300, total 2400. 2 materials, 2 textures, 1 MB file.
No rigging, shape keys, animation, transparency or lights. Parts move rigidly with the headset and controllers.
