from gaanim import Scene

import style

scene = Scene()
style.card(scene, style.TITLE)
scene.media.sfx("jingle.wav")
scene.wait(1)
scene.render()
