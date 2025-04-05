import xml.etree.ElementTree as ET
import re
import html

# Define namespaces used in the GraphML
namespaces = {
    '': 'http://graphml.graphdrawing.org/xmlns',  # Default namespace (no prefix)
    'y': 'http://www.yworks.com/xml/yfiles-common/3.0',
    'x': 'http://www.yworks.com/xml/yfiles-common/markup/3.0',
    'yjs': 'http://www.yworks.com/xml/yfiles-for-html/3.0/xaml'
}

# Register namespaces to avoid ns0 prefix
for prefix, uri in namespaces.items():
    ET.register_namespace(prefix, uri)

# Input and output file paths
input_file = 'edited.graphml'  # Replace with your GraphML file path
output_file = 'simplified_edited.graphml'  # Where the simplified file will be saved

# Function to strip HTML-like tags and clean text
def clean_text(text):
    if text is None:
        return ""
    # Remove <![CDATA[ and ]]>
    text = re.sub(r'<!\[CDATA\[|\]\]>', '', text)
    # Decode HTML entities (e.g., &nbsp; -> space, &amp; -> &)
    text = html.unescape(text)
    # Remove <p>, <strong>, <em>, <ul>, <li>, etc., keeping content inside
    text = re.sub(r'</?(p|strong|em|ul|li)>', '', text)
    # Remove zero-width no-break space (BOM or formatting artifact)
    text = text.replace('\ufeff', '')
    # Replace multiple spaces/newlines with a single space
    text = re.sub(r'\s+', ' ', text).strip()
    return text

# Parse the GraphML file
tree = ET.parse(input_file)
root = tree.getroot()

# Find the graph element using the default namespace URI
graph = root.find('.//{http://graphml.graphdrawing.org/xmlns}graph', namespaces)

# Remove all <key> elements (metadata definitions)
for key in root.findall('.//{http://graphml.graphdrawing.org/xmlns}key', namespaces):
    root.remove(key)

# Remove <data key="d19"> (shared data)
for data_d19 in root.findall('.//{http://graphml.graphdrawing.org/xmlns}data[@key="d19"]', namespaces):
    root.remove(data_d19)

# Process each node
for node in graph.findall('.//{http://graphml.graphdrawing.org/xmlns}node', namespaces):
    # Collect <data> elements to remove (except d4)
    data_to_remove = []
    for data in node.findall('.//{http://graphml.graphdrawing.org/xmlns}data', namespaces):
        if data.get('key') != 'd4':
            data_to_remove.append(data)
    
    # Remove collected <data> elements
    for data in data_to_remove:
        if data in node:
            node.remove(data)
    
    # Simplify <data key="d4"> to keep only the label text
    data_d4 = node.find('.//{http://graphml.graphdrawing.org/xmlns}data[@key="d4"]', namespaces)
    if data_d4 is not None:
        # Check for nested <y:Label.Text>
        label_text_elem = data_d4.find('.//{http://www.yworks.com/xml/yfiles-common/3.0}Label.Text', namespaces)
        if label_text_elem is not None:
            # Use the nested text and clean it
            label_text = clean_text(label_text_elem.text)
        else:
            # Check for <y:Label Text="..."> attribute
            label_elem = data_d4.find('.//{http://www.yworks.com/xml/yfiles-common/3.0}Label', namespaces)
            if label_elem is not None and 'Text' in label_elem.attrib:
                label_text = clean_text(label_elem.attrib['Text'])
            else:
                # If no label text found, remove the <data key="d4">
                if data_d4 in node:
                    node.remove(data_d4)
                continue
        
        # Replace the entire <data> content with standardized, cleaned <y:Label.Text>
        data_d4.clear()
        data_d4.set('key', 'd4')
        label_text_elem = ET.SubElement(data_d4, '{http://www.yworks.com/xml/yfiles-common/3.0}Label.Text')
        label_text_elem.text = label_text
    
    # Remove all <port> elements
    ports_to_remove = node.findall('.//{http://graphml.graphdrawing.org/xmlns}port', namespaces)
    for port in ports_to_remove:
        if port in node:
            node.remove(port)

# Process each edge
for edge in graph.findall('.//{http://graphml.graphdrawing.org/xmlns}edge', namespaces):
    # Collect <data> elements to remove (except d11)
    data_to_remove = []
    for data in edge.findall('.//{http://graphml.graphdrawing.org/xmlns}data', namespaces):
        if data.get('key') != 'd11':
            data_to_remove.append(data)
    
    # Remove collected <data> elements
    for data in data_to_remove:
        if data in edge:
            edge.remove(data)
    
    # Simplify <data key="d11"> to keep only <y:Label.Text>
    data_d11 = edge.find('.//{http://graphml.graphdrawing.org/xmlns}data[@key="d11"]', namespaces)
    if data_d11 is not None:
        # Check for nested <y:Label.Text>
        label_text_elem = data_d11.find('.//{http://www.yworks.com/xml/yfiles-common/3.0}Label.Text', namespaces)
        if label_text_elem is not None:
            label_text = clean_text(label_text_elem.text)
        else:
            # Check for <y:Label Text="..."> attribute
            label_elem = data_d11.find('.//{http://www.yworks.com/xml/yfiles-common/3.0}Label', namespaces)
            if label_elem is not None and 'Text' in label_elem.attrib:
                label_text = clean_text(label_elem.attrib['Text'])
            else:
                # If no label text found, remove the <data key="d11">
                if data_d11 in edge:
                    edge.remove(data_d11)
                continue
        
        # Replace the entire <data> content with standardized, cleaned <y:Label.Text>
        data_d11.clear()
        data_d11.set('key', 'd11')
        label_text_elem = ET.SubElement(data_d11, '{http://www.yworks.com/xml/yfiles-common/3.0}Label.Text')
        label_text_elem.text = label_text
    
    # Remove sourceport and targetport attributes if present
    if 'sourceport' in edge.attrib:
        del edge.attrib['sourceport']
    if 'targetport' in edge.attrib:
        del edge.attrib['targetport']

# Simplify the root element (remove unnecessary namespace declarations)
root.attrib = {
    'xmlns': 'http://graphml.graphdrawing.org/xmlns',
    'xmlns:y': 'http://www.yworks.com/xml/yfiles-common/3.0',
    'xmlns:x': 'http://www.yworks.com/xml/yfiles-common/markup/3.0'
}

# Write the simplified GraphML to a new file
tree.write(output_file, encoding='utf-8', xml_declaration=True)

print(f"Simplified GraphML saved to {output_file}")