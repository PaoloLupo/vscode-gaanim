from gaanim import Scene

TITLE = "Channel"


def card(scene: Scene, text: str):
    return scene.text(text, role="title")
