NAME := tab-close-to-left
SRC  := manifest.json background.js

.PHONY: all clean

all: $(NAME).xpi

$(NAME).xpi: $(SRC)
	rm -f $@
	zip -q $@ $(SRC)

clean:
	rm -f $(NAME).xpi
