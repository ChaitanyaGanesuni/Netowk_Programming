import java.io.File;
import java.io.FileNotFoundException;
import java.util.HashMap;
import java.util.Map;
import java.util.Map.Entry;
import java.util.Scanner;
public class CountWord {
	static void getWords(String fileName,Map<String, Integer> words)
		throws FileNotFoundException
	{
		Scanner file = new Scanner(new File(fileName));
		while (file.hasNext()) {
			String word = file.next();
			Integer count = words.get(word);
			if (count != null) {
				count++;
			}
			else
				count = 1;
			words.put(word, count);
		}
		file.close();
	}
	static int getMaxOccurance(Map<String, Integer> words)
	{
		int max = 1;
		for (Entry<String, Integer> word :
			words.entrySet()) {

			if (word.getValue() > max) {
				max = word.getValue();
			}
		}

		// Return the maximum value from the Map
		return max;
	}

	public static void main(String[] args)
		throws FileNotFoundException
	{
		Map<String, Integer> words
			= new HashMap<String, Integer>();

		getWords("C:\\Users\\chait_7ux09e0\\OneDrive\\Desktop\\np_lab\\sample.txt", words);

		int max = getMaxOccurance(words);
		for (Entry<String, Integer> word :
			words.entrySet()) {
			if (word.getValue() == max) {
				System.out.println(word);
			}
		}
	}
}